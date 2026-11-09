/** The agent's device half. It answers on its own, offline, from what the
 *  device keeps; logs everything you do to an outbox; learns from it at once;
 *  and when there is a connection, hands the outbox to the cloud agent and
 *  takes back the sphere it redraws. The handoff is silent: nothing waits on it. */
import * as idb from "@/lib/device/db"
import { byRules, currentMoment, INTENT_SCHEMA, intentPrompt, merge } from "@/lib/device/intent"
import * as llm from "@/lib/device/llm"
import { EMPTY_LOCAL, learn, rank, type LocalProfile, type Pick } from "@/lib/device/rank"
import { EMPTY_PROFILE, type Angle, type CatalogItem, type CloudProfile, type DeviceEvent, type EventKind, type Intent } from "@/lib/hybrid/types"

export type Reading = { id: number; title: string; site: string; byline: string | null; url: string; minutes: number; html: string | null; type: string | null; original: string | null }

export type AgentState = {
  ready: boolean
  items: CatalogItem[]
  cloud: CloudProfile
  local: LocalProfile
  cloudModel: string | null
  unlabeled: number
  online: boolean
  queued: number
  lastSync: number | null
  syncing: boolean
  /** The version of the sphere last seen, so a redraw can be announced. */
  seenVersion: number
  intent: Intent | null
  intentAt: number
  signals: DeviceEvent[]
  cachedReadings: number
  shareSpeech: boolean
}

let state: AgentState = {
  ready: false, items: [], cloud: EMPTY_PROFILE, local: EMPTY_LOCAL, cloudModel: null, unlabeled: 0, online: true,
  queued: 0, lastSync: null, syncing: false, seenVersion: 0, intent: null, intentAt: 0, signals: [], cachedReadings: 0, shareSpeech: true,
}
const listeners = new Set<() => void>()
const set = (patch: Partial<AgentState>) => { state = { ...state, ...patch }; listeners.forEach(l => l()) }
export const getState = () => state
export const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

/** How long what you said about yourself still describes you. */
const INTENT_LIFE = 45 * 60_000
const activeIntent = () => (state.intent && Date.now() - state.intentAt < INTENT_LIFE ? state.intent : null)

export function deviceId(): string {
  try {
    let id = localStorage.getItem("brainy:device")
    if (!id) localStorage.setItem("brainy:device", id = `${currentMoment().device}-${crypto.randomUUID().slice(0, 8)}`)
    return id
  } catch { return "device" }
}

let started = false
export async function start(): Promise<void> {
  if (started) return
  started = true
  const [items, cloud, local, outbox, readings, shareSpeech] = await Promise.all([
    idb.all<CatalogItem>("catalog"), idb.get<CloudProfile>("kv", "cloud"), idb.get<LocalProfile>("kv", "local"),
    idb.keys("outbox"), idb.keys("readings"), idb.get<boolean>("kv", "shareSpeech"),
  ])
  set({
    ready: true, items, cloud: cloud ?? EMPTY_PROFILE, local: local ?? EMPTY_LOCAL, queued: outbox.length, cachedReadings: readings.length,
    online: navigator.onLine, seenVersion: (await idb.get<number>("kv", "seenVersion")) ?? 0, shareSpeech: shareSpeech ?? true,
  })
  addEventListener("online", () => { set({ online: true }); void sync() })
  addEventListener("offline", () => set({ online: false }))
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void sync() })
  setInterval(() => void sync(), 20_000)
  await sync(true)
}

/** Hand the outbox to the cloud and take back the sphere; never throws, as offline is normal. */
let syncing: Promise<void> | null = null
export function sync(catalogToo = false, relabel = false): Promise<void> {
  return syncing ??= (async () => {
    if (!navigator.onLine) { set({ online: false }); return }
    set({ syncing: true })
    try {
      const outbox = await idb.all<DeviceEvent>("outbox")
      const response = await fetch("/api/hybrid/sync", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: outbox, relabel, since: Date.now() - 6 * 3600_000 }),
      })
      if (!response.ok) throw new Error(`sync answered ${response.status}`)
      const { profile, signals } = await response.json() as { profile: CloudProfile; signals: DeviceEvent[] }
      await idb.remove("outbox", outbox.map(e => e.id))
      const changed = profile.version !== state.cloud.version
      await idb.put("kv", "cloud", profile)
      set({ cloud: profile, signals, queued: Math.max(0, state.queued - outbox.length), online: true, lastSync: Date.now() })
      // The catalogue carries each item's cluster, which a redraw moves, and new labels.
      if (catalogToo || changed || state.unlabeled > 0 || !state.items.length) await refreshCatalog()
    } catch (error) {
      console.warn("Sync failed; the device carries on alone", error)
    } finally {
      set({ syncing: false })
      syncing = null
    }
  })()
}

async function refreshCatalog(): Promise<void> {
  const response = await fetch("/api/hybrid/catalog")
  if (!response.ok) return
  const { items, profile, cloud } = await response.json() as { items: CatalogItem[]; profile: CloudProfile; cloud: { model: string | null; unlabeled: number } }
  await idb.replace("catalog", items.map(item => [item.id, item]))
  await idb.put("kv", "cloud", profile)
  set({ items, cloud: profile, cloudModel: cloud.model, unlabeled: cloud.unlabeled })
  void keepReadings(items)
}

/** Keep the readings of what you're likeliest to open, and their pictures, for offline. */
let keeping = false
async function keepReadings(items: CatalogItem[]): Promise<void> {
  if (keeping) return
  keeping = true
  try {
    const have = new Set(await idb.keys("readings"))
    const wanted = items.filter(i => i.modality === "read" && i.progress < 0.95).slice(0, 60)
    for (const item of wanted) {
      if (have.has(item.id) || !navigator.onLine) continue
      const response = await fetch(`/api/hybrid/article/${item.id}`).catch(() => null)
      if (!response?.ok) continue
      const reading = await response.json() as Reading
      await idb.put("readings", item.id, reading)
      have.add(item.id)
      set({ cachedReadings: have.size })
      // Fetching the pictures puts them in the service worker's cache.
      for (const src of (reading.html ?? "").matchAll(/<img[^>]+src="(\/images\/[^"]+)"/g)) await fetch(src[1]).catch(() => null)
    }
  } finally { keeping = false }
}

export async function reading(id: number): Promise<Reading | null> {
  const kept = await idb.get<Reading>("readings", id)
  if (kept) return kept
  const response = await fetch(`/api/hybrid/article/${id}`).catch(() => null)
  if (!response?.ok) return null
  const fetched = await response.json() as Reading
  await idb.put("readings", id, fetched)
  return fetched
}

/** How much each kind of event says you wanted the item, for learning on the spot. */
const SIGNAL: Partial<Record<EventKind, number>> = { accepted: 1, opened: 0.6, swiped: -1 }

export async function record(kind: EventKind, item?: CatalogItem, data?: Record<string, unknown>): Promise<void> {
  const moment = currentMoment(activeIntent())
  const event: DeviceEvent = { id: crypto.randomUUID(), device: deviceId(), at: Date.now(), kind, articleId: item?.id, moment, data }
  await idb.put("outbox", event.id, event)
  let local = state.local
  const signal = kind === "read" ? Number(data?.delta ?? 0) * 1.5 : SIGNAL[kind]
  if (item && signal) local = learn(local, item, moment, signal)
  await idb.put("kv", "local", local)
  set({ local, queued: state.queued + 1 })
  if (kind === "accepted" || kind === "swiped" || kind === "closed") void sync()
}

export type Answer = { intent: Intent; picks: Pick[]; parsedBy: string }

/** What you said, read on the device, and the picks for it. */
export async function ask(text: string): Promise<Answer> {
  const topics = [...new Set(state.items.flatMap(i => i.labels?.topics ?? []))]
  const rules = byRules(text, topics)
  const model = await llm.parseIntent<Partial<Intent>>(text, topics, intentPrompt(text, topics), INTENT_SCHEMA)
  // A follow-up ("something shorter") keeps what you said about yourself before.
  const before = activeIntent()
  let intent = merge(rules, model)
  if (before) intent = {
    ...intent,
    moods: intent.moods.length ? intent.moods : before.moods,
    energy: intent.energy ?? before.energy,
    setting: intent.setting ?? before.setting,
    minutes: intent.minutes ?? before.minutes,
    audioOk: intent.audioOk && before.audioOk,
    modality: intent.modality === "any" ? before.modality : intent.modality,
  }
  const local = { ...state.local, said: [...state.local.said, { text, at: Date.now() }].slice(-12) }
  set({ intent, intentAt: Date.now(), local })
  await record("asked", undefined, state.shareSpeech ? { text, intent } : { intent })
  const picks = rank(state.items, intent, currentMoment(intent), state.local, state.cloud)
  return { intent, picks, parsedBy: model ? (llm.modelState().status === "ready" ? (llm.modelState() as { model: string }).model : "device model") : "rules" }
}

export function picksFor(intent: Intent | null, exclude: Set<number>): Pick[] {
  const i: Intent = intent ?? { minutes: null, energy: null, moods: [], setting: null, modality: "any", audioOk: true, vibes: [], topics: [], avoid: [] }
  return rank(state.items, i, currentMoment(intent), state.local, state.cloud, exclude)
}

/** The cloud's pitch angle that fits the state you're in. */
export function angleFor(intent: Intent): Angle {
  const moods = intent.moods.join(" ")
  if (intent.minutes !== null && intent.minutes <= 10) return "short on time"
  if (/low mood|stressed|sad/.test(moods)) return "need a lift"
  if (intent.setting === "bed" || /evening|night/.test(currentMoment().daypart)) return intent.energy === "low" ? "winding down" : "curious"
  if (intent.energy === "low" || /tired|drained/.test(moods)) return "low energy"
  if (intent.energy === "high" || /curious|energised/.test(moods) || intent.vibes.includes("deep")) return intent.vibes.includes("deep") ? "deep focus" : "curious"
  return "curious"
}

/** Ways in and out, rotated so no two suggestions in a row sound alike. */
const OPENERS = ["", "Try {title}. ", "{title}. ", "Here's one: {title}. ", "Maybe {title}. ", "I'd go with {title}. "]
const CLOSERS = ["", "", " Want it?", " Shall I open it?", " Up for it?", ""]
let turn = 0

/** Why a pick fits, said in a sentence or two: the cloud's analysis, angled to your moment; the device's model, when ready, says it in its own words. */
export async function* pitch(pick: Pick, intent: Intent, said: string): AsyncGenerator<string> {
  const { item } = pick
  const fallback = template(pick, intent)
  if (llm.modelState().status !== "ready" || !said) { yield fallback; return }
  const l = item.labels
  const angle = angleFor(intent)
  let any = false
  try {
    for await (const piece of llm.say([
      { role: "system", content: "You suggest one thing to read to a friend, by voice. One or two short sentences, under 40 words. Use the notes given, especially the pitch, and connect it to what they said. Vary your wording. Do not start with 'How about'. Do not say 'interested'. No lists, no emoji." },
      { role: "user", content: [
        `They said: "${said}"`,
        `Title: ${item.title} (${l?.form ?? item.kind}, ${item.minutes} min)`,
        l?.tone && `Tone: ${l.tone}. Pace: ${l.pace}.`,
        l?.hook && `Hook: ${l.hook}`,
        `Pitch for someone ${angle}: ${l?.pitches?.find(p => p.angle === angle)?.text ?? l?.summary ?? ""}`,
      ].filter(Boolean).join("\n") },
    ], 80)) { any = true; yield piece }
  } catch (error) { console.warn("The on-device model couldn't answer", error) }
  if (!any) yield fallback
}

function template({ item }: Pick, intent: Intent): string {
  const l = item.labels
  const t = turn++
  const title = `"${item.title}"`
  const angle = angleFor(intent)
  const pitched = l?.pitches?.find(p => p.angle === angle)?.text
    // A second suggestion in a row draws on something else: the hook, then the line.
    ?? l?.summary ?? ""
  const body = t % 3 === 1 && l?.hook ? `${l.hook.replace(/^["“”'\s]+/, "").replace(/[.…]?\s*$/, ".")}` : t % 3 === 2 && l?.line ? `It has this line: "${l.line}"` : pitched
  const said = /\d+ minute/.test(body)
  const fit = !said && intent.minutes && item.minutes <= intent.minutes * 1.15 ? ` ${item.minutes} minutes${intent.setting ? `, about right for the ${intent.setting}` : ""}.` : ""
  const opener = OPENERS[t % OPENERS.length].replace("{title}", title)
  const lead = opener || `${title}: `
  return `${lead}${body}${body.trim().endsWith(".") || body.trim().endsWith("\"") ? "" : "."}${fit}${CLOSERS[t % CLOSERS.length]}`.replace(/\s+/g, " ").trim()
}

export async function setShareSpeech(share: boolean) { await idb.put("kv", "shareSpeech", share); set({ shareSpeech: share }) }
export async function markSeen(version: number) { await idb.put("kv", "seenVersion", version); set({ seenVersion: version }) }
export async function forgetLocal() { await idb.put("kv", "local", EMPTY_LOCAL); set({ local: EMPTY_LOCAL }) }
