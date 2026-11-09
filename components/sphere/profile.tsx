"use client"

import { useState, useSyncExternalStore } from "react"
import * as agent from "@/lib/device/agent"
import { currentMoment } from "@/lib/device/intent"
import * as llm from "@/lib/device/llm"
import { momentKeys } from "@/lib/hybrid/types"

const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000)
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`
}

/** What each half of the agent knows of you, and which half knows it, set out like a gallery's notes. */
export function ProfilePanel({ model, modelId, onModel }: { model: llm.ModelState; modelId: string; onModel(id: string): void }) {
  const s = useSyncExternalStore(agent.subscribe, agent.getState, agent.getState)
  const [asked, setAsked] = useState(false)
  const intent = s.intent && Date.now() - s.intentAt < 45 * 60_000 ? s.intent : null
  const keys = momentKeys(currentMoment(intent))
  // Each label once, under the moment it leans most in: thinking styles and vibes first, then topics.
  const strongest = new Map<string, { key: string; label: string; w: number }>()
  for (const key of keys) for (const [label, w] of Object.entries(s.local.leanings[key] ?? {})) {
    const had = strongest.get(label)
    if (!had || Math.abs(w) > Math.abs(had.w)) strongest.set(label, { key, label: label.replace(/^topic:/, "about "), w })
  }
  const all = [...strongest.values()].filter(l => Math.abs(l.w) > 0.02).sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
  const leanings = [...all.filter(l => !l.label.startsWith("about ")).slice(0, 6), ...all.filter(l => l.label.startsWith("about ")).slice(0, 4)]
  const cloud = s.cloud
  return (
    <div className="mt-4 grid gap-8 border-t border-foreground pt-5 text-sm sm:grid-cols-2">
      <section>
        <h3 className="font-bold">On this device</h3>
        <p className="mt-1 text-xs text-muted-foreground">Understands what you say, picks for the moment, and learns from every choice at once, with or without a connection.</p>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Model</dt>
          <dd>{model.status === "ready" ? model.model : model.status === "loading" ? `loading ${Math.round(model.progress * 100)}%` : model.status === "unsupported" ? "none, rules only" : model.status === "error" ? "failed to load" : "not kept yet"}</dd>
          <dt className="text-muted-foreground">Library</dt><dd>{s.items.length} works, {s.cachedReadings} readable offline</dd>
          <dt className="text-muted-foreground">Waiting</dt><dd>{s.queued} events for the cloud</dd>
        </dl>
        {(model.status === "unsupported" || model.status === "error") && <p className="mt-2 text-xs text-muted-foreground">{model.reason}</p>}
        <label className="mt-4 block text-xs text-muted-foreground">Model kept on this device
          <select value={modelId} onChange={e => onModel(e.target.value)} className="mt-1 block w-full border-b border-foreground/30 bg-transparent py-1.5 text-foreground">
            {llm.MODELS.map(m => <option key={m.id} value={m.id}>{m.name} · {m.size} · {m.note}</option>)}
          </select>
        </label>
        {intent && (
          <>
            <h4 className="mt-6 text-xs text-muted-foreground">Right now, from what you said</h4>
            <p className="mt-1">{[intent.minutes && `${intent.minutes} min`, intent.energy && `${intent.energy} energy`, ...intent.moods, intent.setting, !intent.audioOk && "no audio", ...intent.vibes, ...intent.topics.map(t => `about ${t}`)].filter(Boolean).join(" · ")}</p>
          </>
        )}
        <h4 className="mt-6 text-xs text-muted-foreground">Learned here, for moments like this one</h4>
        {leanings.length ? (
          <ul className="mt-2 space-y-1.5">
            {leanings.map(l => (
              <li key={l.label} className="grid grid-cols-[7rem_6.5rem_1fr] items-center gap-2 text-xs">
                <span className="truncate text-muted-foreground">{l.key}</span>
                <span className="truncate">{l.w < 0 ? "less " : ""}{l.label}</span>
                <span className="h-px bg-foreground/10"><span className={`block h-[3px] -translate-y-px ${l.w > 0 ? "bg-foreground" : "bg-foreground/35"}`} style={{ width: `${Math.abs(l.w) * 100}%` }} /></span>
              </li>
            ))}
          </ul>
        ) : <p className="mt-1 text-xs text-muted-foreground">Nothing yet. Open or pass on a few suggestions.</p>}
        <label className="mt-6 flex items-start justify-between gap-4 text-xs">
          <span>Send what I say to the cloud agent<span className="block text-muted-foreground">Off, it gets only what the device drew out of it</span></span>
          <input type="checkbox" checked={s.shareSpeech} onChange={e => void agent.setShareSpeech(e.target.checked)} className="mt-0.5 size-4 accent-black" />
        </label>
        <button onClick={() => void agent.forgetLocal()} className="mt-4 text-xs text-muted-foreground underline underline-offset-4">Forget what this device learned</button>
      </section>

      <section>
        <h3 className="font-bold">In the cloud</h3>
        <p className="mt-1 text-xs text-muted-foreground">Reads every work whole to catalogue it, and redraws your interests from what every device saw you do.</p>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Agent</dt><dd>{s.cloudModel ?? "rules, until a Claude key is added"}</dd>
          <dt className="text-muted-foreground">Redrawn</dt><dd>{cloud.version ? `version ${cloud.version}, ${ago(Date.parse(cloud.updatedAt))}` : "not yet"}</dd>
          <dt className="text-muted-foreground">Last handoff</dt><dd>{s.lastSync ? ago(s.lastSync) : "never"}{s.online ? "" : ", offline now"}</dd>
          {s.unlabeled > 0 && <><dt className="text-muted-foreground">Cataloguing</dt><dd>{s.unlabeled} works to go</dd></>}
        </dl>
        {cloud.summary && <p className="mt-4 leading-relaxed">{cloud.summary}</p>}
        {cloud.clusters.length > 0 && (
          <>
            <h4 className="mt-6 text-xs text-muted-foreground">Interests, by pull</h4>
            <ul className="mt-2 space-y-1.5">
              {cloud.clusters.map(c => (
                <li key={c.name} className="grid grid-cols-[8rem_1fr] items-center gap-2 text-xs">
                  <span className="truncate">{c.name}</span>
                  <span className="h-px bg-foreground/10"><span className="block h-[3px] -translate-y-px bg-foreground" style={{ width: `${c.weight * 100}%` }} /></span>
                </li>
              ))}
            </ul>
          </>
        )}
        {cloud.inferences.length > 0 && (
          <>
            <h4 className="mt-6 text-xs text-muted-foreground">What it infers</h4>
            <ul className="mt-2 space-y-3">
              {cloud.inferences.map(i => (
                <li key={i.text}>
                  <p>{i.text}</p>
                  <p className="text-xs text-muted-foreground">{i.evidence} · {Math.round(i.confidence * 100)}% sure</p>
                </li>
              ))}
            </ul>
          </>
        )}
        {s.signals.length > 0 && (
          <>
            <h4 className="mt-6 text-xs text-muted-foreground">From your phone&apos;s automations</h4>
            <ul className="mt-1 space-y-0.5 text-xs">
              {s.signals.slice(0, 6).map(e => <li key={e.id}>{String(e.data?.app ?? e.data?.focus ?? e.data?.note)}, {ago(e.at)}</li>)}
            </ul>
          </>
        )}
        <button disabled={!s.online || asked} onClick={() => { setAsked(true); void agent.sync(false, true).then(() => setTimeout(() => { void agent.sync(); setAsked(false) }, 6000)) }}
          className="mt-6 bg-foreground px-4 py-2 text-xs font-medium text-background disabled:opacity-40">
          {asked ? "Handing off…" : "Hand off and redraw now"}
        </button>
      </section>
    </div>
  )
}
