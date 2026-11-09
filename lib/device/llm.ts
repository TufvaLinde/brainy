/** The small model that lives on the device. It reads what you say and
 *  answers you, with no connection; its weights are downloaded once and kept
 *  in the browser's cache. Until it is ready, the rules answer alone. */
import type { MLCEngineInterface, ChatCompletionMessageParam } from "@mlc-ai/web-llm"
import { native, nativeStatus } from "@/lib/device/native"

export const MODELS = [
  { id: "Llama-3.2-1B-Instruct-q4f16_1-MLC", name: "Llama 3.2 1B", size: "0.9 GB", note: "iPhone" },
  { id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", name: "Qwen 2.5 1.5B", size: "1.6 GB", note: "iPad, smarter" },
  { id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC", name: "Qwen 2.5 0.5B", size: "0.9 GB", note: "fastest" },
] as const

export type ModelState =
  | { status: "unsupported"; reason: string }
  | { status: "idle"; cached: boolean }
  | { status: "loading"; progress: number; text: string }
  | { status: "ready"; model: string }
  | { status: "error"; reason: string }

let engine: MLCEngineInterface | null = null
/** Which model answers: Apple's, in the iPhone app, or WebLLM's in the browser. */
let backend: "apple" | "webllm" | null = null
let loading: Promise<MLCEngineInterface | null> | null = null
let state: ModelState = { status: "idle", cached: false }
const listeners = new Set<(s: ModelState) => void>()
const set = (next: ModelState) => { state = next; listeners.forEach(l => l(next)) }

export const modelState = () => state
export function onModelState(listener: (s: ModelState) => void) { listeners.add(listener); return () => { listeners.delete(listener) } }

/** Storage buffers per shader the models' compiled kernels ask for. */
const NEEDED_STORAGE_BUFFERS = 10

/** Why this device can't run the model, or null if it can: checked before a gigabyte is downloaded. */
export async function webgpuSupport(): Promise<string | null> {
  type Adapter = { limits: { maxStorageBuffersPerShaderStage: number; maxBufferSize: number } }
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<Adapter | null> } }).gpu
  if (!gpu) return "This browser has no WebGPU. On iPhone and iPad it needs iOS 26 or later."
  let adapter: Adapter | null
  try { adapter = await gpu.requestAdapter() } catch { return "WebGPU failed to start." }
  if (!adapter) return "WebGPU found no GPU to use."
  const buffers = adapter.limits.maxStorageBuffersPerShaderStage
  if (buffers < NEEDED_STORAGE_BUFFERS) return `This GPU allows ${buffers} storage buffers per shader; the model needs ${NEEDED_STORAGE_BUFFERS}.`
  return null
}

/** What the GPU offers, for the info page. */
export async function gpuLimits(): Promise<Record<string, number> | null> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ limits: Record<string, number> } | null> } }).gpu
  const adapter = await gpu?.requestAdapter().catch(() => null)
  if (!adapter) return null
  const { maxStorageBuffersPerShaderStage, maxBufferSize, maxStorageBufferBindingSize, maxComputeWorkgroupStorageSize } = adapter.limits
  return { maxStorageBuffersPerShaderStage, maxBufferSize, maxStorageBufferBindingSize, maxComputeWorkgroupStorageSize }
}

export async function isCached(id: string): Promise<boolean> {
  const { hasModelInCache } = await import("@mlc-ai/web-llm")
  return hasModelInCache(id).catch(() => false)
}

/** Load the model, from the cache if it was downloaded before. */
export function load(id: string): Promise<MLCEngineInterface | null> {
  return loading ??= (async () => {
    // Inside the iPhone app, Apple's own on-device model: already on the phone, nothing to download.
    const app = await nativeStatus()
    if (app?.llm === "available") { backend = "apple"; set({ status: "ready", model: "Apple on-device model" }); return null }
    if (app) { set({ status: "unsupported", reason: `Apple's model is ${app.llm.replace(/^unavailable: /, "unavailable: ")}` }); return null }
    const unsupported = await webgpuSupport()
    if (unsupported) { set({ status: "unsupported", reason: unsupported }); return null }
    set({ status: "loading", progress: 0, text: "Starting" })
    const web = await import("@mlc-ai/web-llm")
    const initProgressCallback = (p: { progress: number; text: string }) => set({ status: "loading", progress: p.progress, text: p.text })
    // A short context keeps the model's memory small enough for a phone.
    const chat = { context_window_size: 2048 }
    try {
      try {
        const worker = new Worker(new URL("./llm.worker.ts", import.meta.url), { type: "module" })
        engine = await web.CreateWebWorkerMLCEngine(worker, id, { initProgressCallback }, chat)
      } catch (error) {
        // Some browsers have WebGPU only on the main thread.
        console.warn("The model's worker failed; loading it on the main thread", error)
        engine = await web.CreateMLCEngine(id, { initProgressCallback }, chat)
      }
      backend = "webllm"
      set({ status: "ready", model: MODELS.find(m => m.id === id)?.name ?? id })
      return engine
    } catch (error) {
      loading = null
      set({ status: "error", reason: error instanceof Error ? error.message : String(error) })
      return null
    }
  })()
}

/** JSON the model's grammar holds to a schema, or null if it isn't ready or fails. */
export async function json<T>(messages: ChatCompletionMessageParam[], schema: object): Promise<T | null> {
  if (!engine) return null
  try {
    const reply = await engine.chat.completions.create({
      messages, temperature: 0, max_tokens: 160,
      response_format: { type: "json_object", schema: JSON.stringify(schema) },
    })
    return JSON.parse(reply.choices[0]?.message.content ?? "null") as T
  } catch (error) {
    console.warn("The on-device model couldn't parse that", error)
    return null
  }
}

/** A short reply, token by token. */
export async function* say(messages: ChatCompletionMessageParam[], maxTokens = 70): AsyncGenerator<string> {
  if (backend === "apple") {
    const system = messages.filter(m => m.role === "system").map(m => String(m.content)).join("\n")
    const prompt = messages.filter(m => m.role !== "system").map(m => String(m.content)).join("\n")
    const { text } = await native()!.call<{ text: string }>("say", { system, prompt })
    yield text
    return
  }
  if (!engine) return
  const stream = await engine.chat.completions.create({ messages, temperature: 0.7, max_tokens: maxTokens, stream: true })
  for await (const chunk of stream) {
    const piece = chunk.choices[0]?.delta.content
    if (piece) yield piece
  }
}

const MODEL_KEY = "brainy:model"
/** The model this device keeps, as chosen on the info page. */
export function chosenModel(): string {
  try { return localStorage.getItem(MODEL_KEY) ?? MODELS[0].id } catch { return MODELS[0].id }
}
export function chooseModel(id: string) {
  try { localStorage.setItem(MODEL_KEY, id) } catch {}
  location.reload()
}

/** What was said, as intent parameters: Apple's model fills them in directly in the app; WebLLM answers JSON in a browser. */
export async function parseIntent<T>(text: string, topics: string[], messages: ChatCompletionMessageParam[], schema: object): Promise<T | null> {
  if (backend === "apple") {
    try { return await native()!.call<T>("intent", { text, topics }) } catch (error) { console.warn("Apple's model couldn't parse that", error); return null }
  }
  return json<T>(messages, schema)
}
