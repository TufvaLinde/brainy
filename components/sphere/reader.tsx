"use client"

import { ArrowLeft } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import * as agent from "@/lib/device/agent"
import { kindLabel } from "@/components/sphere/orb"
import type { CatalogItem } from "@/lib/hybrid/types"

/** An item opened from the globe, read in the page's own column, from the
 *  device's own copy when it has one. How far you get is the strongest signal
 *  the agent learns from: each fifth of the way is an event, and leaving says
 *  how long you stayed. */
export function Reader({ item, onClose }: { item: CatalogItem; onClose(): void }) {
  const [reading, setReading] = useState<agent.Reading | null | undefined>(undefined)
  const [progress, setProgress] = useState(item.progress)
  const body = useRef<HTMLDivElement>(null)
  const reported = useRef(Math.floor(item.progress * 5) / 5)
  const opened = useRef(Date.now())
  const furthest = useRef(item.progress)

  useEffect(() => { void agent.reading(item.id).then(setReading) }, [item.id])

  // How far down the article the bottom of the screen has reached.
  useEffect(() => {
    const onScroll = () => {
      const el = body.current
      if (!el) return
      const { top, height } = el.getBoundingClientRect()
      const p = Math.min(1, Math.max(0, (innerHeight - top) / Math.max(1, height)))
      setProgress(p)
      furthest.current = Math.max(furthest.current, p)
      const step = Math.floor(p * 5) / 5
      if (step > reported.current) {
        void agent.record("read", item, { progress: step, delta: step - reported.current })
        reported.current = step
      }
    }
    addEventListener("scroll", onScroll, { passive: true })
    return () => removeEventListener("scroll", onScroll)
  }, [item])

  const close = () => {
    const seconds = Math.round((Date.now() - opened.current) / 1000)
    void agent.record("closed", item, { progress: furthest.current, seconds })
    // The library keeps the place too, so its own reader opens there.
    if (navigator.onLine) void fetch("/api/progress", {
      method: "POST", keepalive: true, headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: item.id, progress: furthest.current, updatedAt: Date.now() }),
    }).catch(() => {})
    onClose()
  }

  const media = reading?.type?.match(/^(audio|video)\//)?.[1]
  return (
    <article className="mx-auto mt-6 max-w-[38rem] animate-[rise_0.35s_ease-out]">
      <div className="sticky top-0 z-10 -mx-6 flex items-center gap-4 bg-background/95 px-6 py-3 text-xs text-muted-foreground backdrop-blur">
        <button onClick={close} className="flex items-center gap-1.5 font-medium text-foreground"><ArrowLeft className="size-4" /> Back to the globe</button>
        <span className="flex-1" />
        <span className="tabular-nums">{Math.max(1, Math.round(item.minutes * (1 - progress)))} min left</span>
      </div>
      <div className="h-px bg-foreground/10"><div className="h-px bg-foreground" style={{ width: `${progress * 100}%` }} /></div>
      <header className="mt-10 mb-10">
        <p className="text-xs text-muted-foreground">{item.site} · {kindLabel(item)} · {item.minutes} min</p>
        <h1 className="mt-3 text-balance text-4xl font-bold leading-[0.98] tracking-[-0.03em] sm:text-5xl">{item.title}</h1>
        {reading?.byline && <p className="mt-4 text-sm">{reading.byline}</p>}
      </header>
      <div ref={body}>
        {reading === undefined && <p className="text-muted-foreground">Opening…</p>}
        {reading === null && <p className="text-muted-foreground">This one isn&apos;t on the device yet, and there&apos;s no connection to fetch it. It will be kept next time you&apos;re online.</p>}
        {media && reading?.original && (media === "video"
          ? <video src={reading.original} controls playsInline className="w-full bg-black" />
          : <audio src={reading.original} controls className="w-full" />)}
        {reading?.html && <div className="article [--article-font:var(--font-sans)]" dir="auto" dangerouslySetInnerHTML={{ __html: reading.html }} />}
      </div>
      <button onClick={close} className="mt-12 mb-4 flex items-center gap-1.5 text-sm font-medium"><ArrowLeft className="size-4" /> Back to the globe</button>
    </article>
  )
}
