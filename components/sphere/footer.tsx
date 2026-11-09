"use client"

import Link from "next/link"
import { useEffect, useState, useSyncExternalStore } from "react"
import * as agent from "@/lib/device/agent"
import * as llm from "@/lib/device/llm"

/** The machinery, out of the way: one line at the very bottom, and the info page for the rest. */
export function DeviceFooter() {
  const model = useSyncExternalStore(llm.onModelState, llm.modelState, llm.modelState)
  const state = useSyncExternalStore(agent.subscribe, agent.getState, agent.getState)
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const chosen = llm.MODELS.find(m => m.id === llm.chosenModel())
  if (!mounted) return <footer className="mt-16 border-t border-foreground/15 pt-4" />
  return (
    <footer className="mt-16 border-t border-foreground/15 pt-4 text-xs text-muted-foreground">
      <p>
        {model.status === "ready" ? "Brainy can talk to you offline on this device."
          : model.status === "loading" ? `Putting Brainy on this device… ${Math.round(model.progress * 100)}%`
          : model.status === "idle" ? <>To talk to Brainy offline, <button onClick={() => void llm.load(llm.chosenModel())} className="underline underline-offset-4 hover:text-foreground">keep it on this device</button> ({chosen?.size}, once, best on wifi).</>
          : "This device can't run Brainy's model, so it understands you by simpler rules."}
        {" "}{state.online ? "" : `You're offline; ${state.queued} things will sync later.`}
      </p>
      <p className="mt-2"><Link href="/about" className="underline underline-offset-4 hover:text-foreground">How Brainy works, and what it knows about you</Link></p>
    </footer>
  )
}
