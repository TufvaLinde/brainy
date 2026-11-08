"use client"

import { useEffect, useEffectEvent } from "react"

/** Single-key shortcuts, as Readwise Reader has them, by `KeyboardEvent.key`.
 *  Never while typing, nor inside a popup, whose keys are its own, nor with a
 *  modifier, which belongs to the browser. A character carries its own Shift:
 *  "?" is Shift+/. */
export function useKeys(keys: Record<string, () => void>) {
  const onKeyDown = useEffectEvent((e: KeyboardEvent) => {
    const target = e.target instanceof Element ? e.target : null
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (target?.closest("input, textarea, select, [contenteditable], [role=dialog], [role=listbox]")) return
    const press = keys[e.key]
    if (!press) return
    e.preventDefault()
    press()
  })

  useEffect(() => {
    addEventListener("keydown", onKeyDown)
    return () => removeEventListener("keydown", onKeyDown)
  }, [])
}
