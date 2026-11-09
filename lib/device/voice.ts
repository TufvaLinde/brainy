import { native } from "@/lib/device/native"

/** Speech in and out with the phone's own voices. iOS transcribes on the
 *  device for English when it can, and its voices speak offline. */

type Recognition = {
  lang: string; interimResults: boolean; continuous: boolean
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void; stop(): void; abort(): void
}
type RecognitionClass = new () => Recognition

function recognitionClass(): RecognitionClass | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionClass; webkitSpeechRecognition?: RecognitionClass }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}
export const canListen = () => typeof window !== "undefined" && (native() !== null || recognitionClass() !== null)

/** Listen until you pause; partial words as they come, then the whole. Answers a function that stops it. */
export function listen(on: { partial(text: string): void; final(text: string): void; error(reason: string): void }): () => void {
  // In the iPhone app: Apple's on-device recognition, which works in airplane mode.
  const app = native()
  if (app) {
    let done = false
    const off = app.on("speech", data => {
      if (done) return
      if (typeof data.error === "string") { done = true; off(); on.error(data.error); return }
      const text = String(data.text ?? "")
      if (data.final) { done = true; off(); if (text) on.final(text); else on.error("Didn't catch that") } else on.partial(text)
    })
    app.call("listen").catch((error: unknown) => { done = true; off(); on.error(error instanceof Error ? error.message : String(error)) })
    return () => { void app.call("stopListening") }
  }
  const Class = recognitionClass()
  if (!Class) { on.error("This browser can't transcribe speech: type, or use the keyboard's microphone"); return () => {} }
  const r = new Class()
  r.lang = navigator.language || "en-US"
  r.interimResults = true
  r.continuous = false
  let text = "", finished = false
  r.onresult = e => {
    text = Array.from(e.results).map(result => result[0].transcript).join(" ").trim()
    on.partial(text)
  }
  r.onerror = e => {
    if (finished) return
    finished = true
    on.error(e.error === "not-allowed" ? "Allow the microphone for this app in Settings" : e.error === "network" ? "Speech needs a connection here: type instead" : e.error === "no-speech" ? "Didn't catch that" : `Speech failed: ${e.error}`)
  }
  r.onend = () => {
    if (finished) return
    finished = true
    if (text) on.final(text)
    else on.error("Didn't catch that")
  }
  r.start()
  return () => r.stop()
}

let voice: SpeechSynthesisVoice | null | undefined
function pickVoice(): SpeechSynthesisVoice | null {
  if (voice !== undefined) return voice
  const voices = speechSynthesis.getVoices()
  if (!voices.length) return null
  const lang = (navigator.language || "en").slice(0, 2)
  const local = voices.filter(v => v.localService && v.lang.startsWith(lang))
  voice = local.find(v => /premium|enhanced|siri/i.test(v.name)) ?? local.find(v => /samantha|ava|zoe|daniel/i.test(v.name)) ?? local[0] ?? voices[0] ?? null
  return voice
}

/** Say it aloud; each word reported as spoken, which the sphere pulses to. */
export function speak(text: string, on: { word?(): void; end?(): void } = {}): () => void {
  if (typeof speechSynthesis === "undefined") { on.end?.(); return () => {} }
  speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  const v = pickVoice()
  if (v) u.voice = v
  u.rate = 1.04
  u.onboundary = () => on.word?.()
  u.onend = () => on.end?.()
  u.onerror = () => on.end?.()
  speechSynthesis.speak(u)
  return () => speechSynthesis.cancel()
}
