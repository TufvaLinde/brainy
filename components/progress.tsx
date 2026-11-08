"use client"

import { useEffect, useEffectEvent, useRef } from "react"
import { articleElement } from "@/lib/dom"

/** How far down the article the user is: a hairline along the top of the
 *  screen, saved a second after the scrolling stops, or as the user leaves,
 *  and where the article opens next time unless it was read to the end. Read
 *  means scrolled past: the bottom of the screen has reached that far. Opening
 *  it saves nothing, so one read to the end stays read until it is scrolled again. */
export function Progress({ id, progress }: { id: number; progress: number }) {
  const bar = useRef<HTMLDivElement>(null)
  // What it opened at, not what is saved as it is read.
  const opened = useEffectEvent(() => progress)

  useEffect(() => {
    const article = articleElement()
    const top = () => article.getBoundingClientRect().top + scrollY
    const start = opened()
    if (start > 0 && start < 0.99) scrollTo({ top: top() + start * article.offsetHeight - innerHeight })

    const line = bar.current!
    const read = () => Math.min(1, Math.max(0, (scrollY + innerHeight - top()) / Math.max(1, article.offsetHeight)))
    const draw = () => {
      line.style.transform = `scaleX(${read()})`
    }
    let unsaved: { progress: number; updatedAt: number } | null = null
    let timer = 0
    // A request that can finish as the page closes; one that fails is tried
    // again with the next save, unless a newer position is waiting by then.
    const save = () => {
      if (!unsaved) return
      const position = unsaved
      unsaved = null
      void fetch("/api/progress", {
        method: "POST",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, ...position }),
      })
        .then((response) => {
          if (!response.ok) throw new Error("Progress was not saved")
        })
        .catch(() => {
          unsaved ??= position
        })
    }
    const onScroll = () => {
      // Leaving, the next page scrolls before this one is gone, its article already taken away.
      if (!article.isConnected) return
      draw()
      unsaved = { progress: read(), updatedAt: Date.now() }
      clearTimeout(timer)
      timer = window.setTimeout(save, 1000)
    }
    draw()
    addEventListener("scroll", onScroll, { passive: true })
    addEventListener("pagehide", save)
    const observer = new ResizeObserver(draw)
    observer.observe(article)
    return () => {
      clearTimeout(timer)
      save()
      removeEventListener("scroll", onScroll)
      removeEventListener("pagehide", save)
      observer.disconnect()
    }
  }, [id])

  return (
    <div ref={bar} className="fixed inset-x-0 top-0 z-20 h-0.5 origin-left bg-foreground/60" style={{ transform: "scaleX(0)" }} />
  )
}
