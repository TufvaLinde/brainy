"use client"

import { ArrowLeft, ArrowRight, Keyboard, Mic } from "lucide-react"
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import * as agent from "@/lib/device/agent"
import * as llm from "@/lib/device/llm"
import { native } from "@/lib/device/native"
import type { Pick } from "@/lib/device/rank"
import { canListen, listen, speak } from "@/lib/device/voice"
import type { CatalogItem, Intent } from "@/lib/hybrid/types"
import { kindLabel, Orb, thumbnail } from "@/components/sphere/orb"
import { Reader } from "@/components/sphere/reader"

type Phase = "idle" | "listening" | "thinking" | "presenting"
type Suggestion = { picks: Pick[]; index: number; intent: Intent | null; said: string; parsedBy: string | null }

const emptyIntent: Intent = { minutes: null, energy: null, moods: [], setting: null, modality: "any", audioOk: true, vibes: [], topics: [], avoid: [] }

/** The agent, at the top of the library: one view of the same library the
 *  lists below hold. Everything in it runs on the device, offline. */
export function SphereSection() {
  const state = useSyncExternalStore(agent.subscribe, agent.getState, agent.getState)
  const host = useRef<HTMLDivElement>(null)
  const section = useRef<HTMLElement>(null)
  const orb = useRef<Orb | null>(null)
  const [phase, setPhase] = useState<Phase>("idle")
  const [heard, setHeard] = useState("")
  const [reply, setReply] = useState("")
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null)
  const [reading, setReading] = useState<CatalogItem | null>(null)
  const [typing, setTyping] = useState(false)
  const stopListening = useRef<() => void>(() => {})
  const stopSpeaking = useRef<() => void>(() => {})
  const pitchRun = useRef(0)

  // Start the agent, and the model if it was downloaded before.
  useEffect(() => {
    void agent.start()
    const id = llm.chosenModel()
    // In the iPhone app, Apple's model is already on the phone: use it straight away.
    if (native()) void llm.load(id)
    else llm.webgpuSupport().then(async reason => {
      if (reason) return llm.load(id)
      if (await llm.isCached(id)) void llm.load(id)
    })
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      navigator.serviceWorker.register("/sw.js").then(async () => {
        const ready = await navigator.serviceWorker.ready
        // What this first visit loaded, kept so the next opens offline.
        const urls = [location.pathname, ...performance.getEntriesByType("resource").map(e => e.name).filter(u => u.startsWith(location.origin))]
        ready.active?.postMessage({ type: "keep", urls })
      }).catch(error => console.warn("No service worker", error))
    }
  }, [])

  const onTap = useCallback((id: number) => {
    const item = agent.getState().items.find(i => i.id === id)
    if (!item) return
    const pick = agent.picksFor(agent.getState().intent, new Set()).find(p => p.item.id === id)
      ?? { item, score: 0, reasons: [{ kind: "time" as const, text: `${item.minutes} min`, asked: false }, ...(item.labels?.vibes ?? []).map(v => ({ kind: "vibe" as const, text: v, asked: false }))] }
    stopSpeaking.current()
    pitchRun.current++
    void orb.current?.focus(id).then(() => {
      setSuggestion({ picks: [pick], index: 0, intent: null, said: "", parsedBy: null })
      setPhase("presenting")
      setReply(item.labels?.summary ?? item.excerpt ?? "")
    })
  }, [])

  // The globe lives as long as the section; while reading, it is only hidden.
  useEffect(() => {
    if (!host.current) return
    const o = new Orb(host.current, id => onTap(id))
    orb.current = o
    if (agent.getState().items.length) o.setItems(agent.getState().items, agent.getState().cloud.clusters)
    return () => { o.dispose(); orb.current = null }
  }, [onTap])

  // Hang the library again whenever the catalogue or the clusters change.
  const layoutKey = `${state.items.length}:${state.cloud.version}:${state.items.filter(i => i.labels).length}`
  useEffect(() => {
    if (state.items.length) orb.current?.setItems(state.items, state.cloud.clusters)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey])

  // A redraw by the cloud agent shows as the globe rehanging itself, with a breath.
  useEffect(() => {
    const v = state.cloud.version
    if (!v || v <= state.seenVersion) return
    if (state.seenVersion > 0) orb.current?.pulse(1)
    void agent.markSeen(v)
  }, [state.cloud.version, state.seenVersion])

  const present = useCallback(async (s: Suggestion, browsing = false) => {
    const pick = s.picks[s.index]
    if (!pick) return
    const run = ++pitchRun.current
    stopSpeaking.current()
    setReply("")
    // Browsing, the card shows the next pick at once; its pitch streams into it.
    if (browsing) setSuggestion(s)
    void agent.record("suggested", pick.item, { rank: s.index, reasons: pick.reasons.filter(r => r.asked).map(r => r.text) })
    const focused = orb.current?.focus(pick.item.id)
    let text = ""
    orb.current?.setThinking(true)
    for await (const piece of agent.pitch(pick, s.intent ?? emptyIntent, s.said)) {
      if (run !== pitchRun.current) return
      text += piece
      setReply(text)
      orb.current?.pulse(0.15)
    }
    orb.current?.setThinking(false)
    await focused
    if (run !== pitchRun.current) return
    setSuggestion(s)
    setPhase("presenting")
    stopSpeaking.current = speak(text.trim(), { word: () => orb.current?.pulse(0.25) })
  }, [])

  const ask = useCallback(async (text: string) => {
    setHeard(text)
    setTyping(false)
    setPhase("thinking")
    orb.current?.setThinking(true)
    orb.current?.release()
    try {
      const answer = await agent.ask(text)
      orb.current?.setThinking(false)
      if (!answer.picks.length) {
        setPhase("idle")
        setSuggestion(null)
        const sorry = agent.getState().items.length ? "Nothing fits that yet. Try saying it another way?" : "Your library hasn't reached this device yet. Connect once and it will."
        setReply(sorry)
        stopSpeaking.current = speak(sorry)
        return
      }
      await present({ picks: answer.picks, index: 0, intent: answer.intent, said: text, parsedBy: answer.parsedBy })
    } catch (error) {
      console.error(error)
      orb.current?.setThinking(false)
      setPhase("idle")
      setReply("Something went wrong on the device. Try again?")
    }
  }, [present])

  const mic = () => {
    stopSpeaking.current()
    if (phase === "listening") { stopListening.current(); return }
    if (!canListen()) { setTyping(true); return }
    setHeard("")
    setReply("")
    setPhase("listening")
    orb.current?.setThinking(true)
    stopListening.current = listen({
      partial: text => { setHeard(text); orb.current?.pulse(0.1) },
      final: text => void ask(text),
      error: reason => { orb.current?.setThinking(false); setPhase(suggestion ? "presenting" : "idle"); setReply(reason); if (/type|connection|browser/.test(reason)) setTyping(true) },
    })
  }

  const browse = (step: 1 | -1) => {
    if (!suggestion) return
    const current = suggestion.picks[suggestion.index]
    const next = suggestion.index + step
    if (step === 1) void agent.record("swiped", current.item, { rank: suggestion.index })
    if (next < 0) return
    if (next >= suggestion.picks.length) {
      // Past the last pick: more, now that what was passed over is known.
      const more = agent.picksFor(suggestion.intent, new Set(suggestion.picks.map(p => p.item.id)))
      if (!more.length) { setReply("That's everything that fits. Tell me more about what you're after?"); return }
      void present({ ...suggestion, picks: [...suggestion.picks, ...more], index: next }, true)
      return
    }
    void present({ ...suggestion, index: next }, true)
  }

  const accept = () => {
    if (!suggestion) return
    const { item } = suggestion.picks[suggestion.index]
    stopSpeaking.current()
    if (suggestion.said) void agent.record("accepted", item, { rank: suggestion.index })
    void agent.record("opened", item, { from: suggestion.said ? "suggestion" : "sphere" })
    setReading(item)
    section.current?.scrollIntoView({ behavior: "smooth" })
  }

  const dismiss = () => {
    stopSpeaking.current()
    pitchRun.current++
    setSuggestion(null)
    setPhase("idle")
    setReply("")
    setHeard("")
    orb.current?.release()
  }

  const closeReader = () => {
    setReading(null)
    dismiss()
    section.current?.scrollIntoView({ behavior: "smooth" })
  }

  const current = suggestion?.picks[suggestion.index]
  return (
    <section ref={section} className="mb-8 scroll-mt-2" aria-label="Ask for something to read">
      {reading && <Reader item={reading} onClose={closeReader} />}
      <div className={reading ? "hidden" : ""}>
        <div ref={host} className="relative -mx-6 h-[min(118vw,76svh)] select-none sm:mx-auto sm:h-[min(52rem,78svh)]" aria-label="Your library on a globe: drag to turn it, tap a work" />

        {phase !== "presenting" && (heard || reply) && (
          <div className="mx-auto -mt-2 max-w-md text-center">
            {heard && <p className="text-sm text-muted-foreground">“{heard}”</p>}
            {reply && <p className="mt-1 text-base">{reply}</p>}
          </div>
        )}

        {suggestion && current && phase === "presenting" && (
          <Card pick={current} index={suggestion.index} count={suggestion.picks.length} reply={reply} parsedBy={suggestion.said ? suggestion.parsedBy : null}
            onAccept={accept} onNext={() => browse(1)} onBack={() => browse(-1)} onClose={dismiss} onTalk={mic} />
        )}

        {phase !== "presenting" && (
          <div className="mt-6 flex flex-col items-center gap-3">
            {typing && (
              <form className="flex w-full max-w-md gap-2" onSubmit={e => { e.preventDefault(); const t = new FormData(e.currentTarget).get("t")?.toString().trim(); if (t) void ask(t) }}>
                <input name="t" autoFocus placeholder="On the metro, no headphones, tired…" className="min-w-0 flex-1 border-b border-foreground bg-transparent py-2 text-base outline-none placeholder:text-muted-foreground" />
                <button className="font-medium underline underline-offset-4">Ask</button>
              </form>
            )}
            <div className="flex items-center gap-8">
              <button onClick={() => setTyping(t => !t)} aria-label="Type instead" className="grid size-10 place-items-center text-muted-foreground hover:text-foreground"><Keyboard className="size-5" /></button>
              <button onClick={mic} aria-label={phase === "listening" ? "Stop listening" : "Talk to the agent"}
                className={`grid size-16 place-items-center rounded-full bg-foreground text-background transition ${phase === "listening" ? "scale-110 ring-8 ring-foreground/10" : ""} ${phase === "thinking" ? "animate-pulse" : ""}`}>
                <Mic className="size-6" />
              </button>
              <span className="size-10" />
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

/** The lifted work's wall label: what you asked about set in black, the rest in grey. */
function Card({ pick, index, count, reply, onAccept, onNext, onBack, onClose, onTalk }: {
  pick: Pick; index: number; count: number; reply: string; parsedBy: string | null
  onAccept(): void; onNext(): void; onBack(): void; onClose(): void; onTalk(): void
}) {
  const { item, reasons } = pick
  const l = item.labels
  const [dx, setDx] = useState(0)
  const start = useRef<number | null>(null)
  // What made it fit, in black where it answers what you asked; the rest is the analysis below.
  const fits = reasons.filter((r, i, all) => all.findIndex(x => x.text === r.text) === i && (r.asked || r.kind === "learned")).slice(0, 4)
  const good = l?.goodFor?.[0]
  const quote = l?.line && !reply.includes(l.line.slice(0, 30)) ? l.line : null
  return (
    <div
      key={item.id}
      className="mx-auto mt-2 max-w-xl animate-[rise_0.45s_cubic-bezier(.2,.8,.2,1)] border-t border-foreground pt-4"
      style={{ transform: `translateX(${dx}px)`, transition: start.current === null ? "transform 0.25s" : "none", touchAction: "pan-y" }}
      onPointerDown={e => { if ((e.target as HTMLElement).closest("button")) return; start.current = e.clientX }}
      onPointerMove={e => { if (start.current !== null) setDx(e.clientX - start.current) }}
      onPointerUp={() => { const d = dx; start.current = null; setDx(0); if (d < -80) onNext(); else if (d > 80) onBack() }}
      onPointerCancel={() => { start.current = null; setDx(0) }}
    >
      <div className="flex items-baseline justify-between gap-4 text-xs text-muted-foreground">
        <p className="truncate">{item.site} · {l?.form ? l.form.charAt(0).toUpperCase() + l.form.slice(1) : kindLabel(item)} · {item.minutes} min</p>
        <p className="shrink-0 tabular-nums">{index + 1} / {count}</p>
      </div>
      <div className="mt-3 flex gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-balance text-3xl font-bold leading-[0.98] tracking-[-0.03em] sm:text-4xl">{item.title}</h2>
          {(l?.tone || l?.pace) && <p className="mt-2 text-sm text-muted-foreground">{[l.tone, l.pace].filter(Boolean).join(" · ")}</p>}
        </div>
        {item.image && <img src={thumbnail(item.image, 256)} alt="" draggable={false} className="h-24 w-auto max-w-28 shrink-0 object-cover" />}
      </div>
      {fits.length > 0 && (
        <p className="mt-3 text-sm font-semibold leading-snug">
          {fits.map(r => r.text).join(" · ")}
        </p>
      )}
      {reply && <p className="mt-4 text-[17px] leading-relaxed">{reply}</p>}
      {quote && <blockquote className="mt-4 text-xl font-bold leading-snug tracking-[-0.02em]">“{quote}”</blockquote>}
      {(l?.takeaway || good || l?.notFor) && (
        <dl className="mt-4 grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1.5 text-sm">
          {l?.takeaway && <><dt className="text-muted-foreground">You get</dt><dd>{l.takeaway}</dd></>}
          {good && <><dt className="text-muted-foreground">Best for</dt><dd>{good.moment}<span className="text-muted-foreground">, {good.why}</span></dd></>}
          {l?.notFor && <><dt className="text-muted-foreground">Not for</dt><dd className="text-muted-foreground">{l.notFor}</dd></>}
        </dl>
      )}
      <div className="mt-5 flex items-center gap-5 text-sm">
        <button onClick={onAccept} className="bg-foreground px-5 py-2.5 font-medium text-background">{item.modality === "read" ? "Read" : item.modality === "listen" ? "Listen" : "Watch"}</button>
        <button onClick={onNext} className="flex items-center gap-1 font-medium">Not this <ArrowRight className="size-4" /></button>
        {index > 0 && <button onClick={onBack} aria-label="Previous" className="text-muted-foreground"><ArrowLeft className="size-4" /></button>}
        <span className="flex-1" />
        <button onClick={onTalk} aria-label="Talk more" className="text-muted-foreground hover:text-foreground"><Mic className="size-5" /></button>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">Close</button>
      </div>
    </div>
  )
}
