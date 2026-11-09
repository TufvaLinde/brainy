"use client"

import Link from "next/link"
import { useEffect, useState, useSyncExternalStore } from "react"
import * as agent from "@/lib/device/agent"
import * as llm from "@/lib/device/llm"
import { native } from "@/lib/device/native"
import { ProfilePanel } from "@/components/sphere/profile"

/** The info page: what runs where, and what each half knows. */
export function About() {
  const model = useSyncExternalStore(llm.onModelState, llm.modelState, llm.modelState)
  // What this device knows lives on this device: shown once it's read, never rendered on the server.
  const [mounted, setMounted] = useState(false)
  const [limits, setLimits] = useState<Record<string, number> | null>(null)
  useEffect(() => {
    setMounted(true)
    void llm.gpuLimits().then(setLimits)
    void agent.start()
    const id = llm.chosenModel()
    if (native()) void llm.load(id)
    else void llm.isCached(id).then(cached => { if (cached) void llm.load(id) })
  }, [])
  return (
    <div className="mt-6">
      <Link href="/" className="text-xs text-muted-foreground underline underline-offset-4">Back to the library</Link>
      <h1 className="mt-6 text-4xl font-bold leading-[0.98] tracking-[-0.03em]">How Brainy works</h1>
      <div className="mt-6 max-w-[38rem] space-y-4 text-[17px] leading-relaxed">
        <p>When you save something, a large model in the cloud reads all of it and writes a short analysis: what kind of piece it is, how it sounds, what you get from it, and when it suits you. That analysis comes to your devices with the library, so every piece arrives already understood.</p>
        <p>When you talk to Brainy, a small model on this device works out what you mean (the time you have, how you feel, what you&apos;re after) and picks from that catalogue. It works without a connection, and what you say stays here unless you choose to share it.</p>
        <p>Everything you open, pass on or finish teaches the device straight away. When there&apos;s a connection, it hands that to the cloud, which redraws your interests across all your devices.</p>
      </div>
      {model.status === "idle" && !model.cached && (
        <button onClick={() => void llm.load(llm.chosenModel())} className="mt-6 bg-foreground px-5 py-2.5 text-sm font-medium text-background">Keep Brainy on this device</button>
      )}
      {mounted && <ProfilePanel model={model} modelId={llm.chosenModel()} onModel={llm.chooseModel} />}
      {limits && (
        <p className="mt-8 text-xs text-muted-foreground">
          This device&apos;s GPU: {limits.maxStorageBuffersPerShaderStage} storage buffers per shader, largest buffer {Math.round(limits.maxBufferSize / 2 ** 20)} MB.
        </p>
      )}
    </div>
  )
}
