/** The on-device model's thread: WebGPU inference off the main thread, so the sphere keeps spinning while it thinks. */
import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm"

const handler = new WebWorkerMLCEngineHandler()
self.onmessage = (message: MessageEvent) => handler.onmessage(message)
