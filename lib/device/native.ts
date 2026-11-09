/** The iPhone app's abilities, when Brainy runs inside it (see ios/Brainy/Bridge.swift):
 *  Apple's on-device model, and on-device speech recognition. In a browser there are none. */

type Native = {
  app: true
  on(name: string, fn: (data: Record<string, unknown>) => void): () => void
  call<T = unknown>(method: string, args?: Record<string, unknown>): Promise<T>
}

export const native = (): Native | null =>
  typeof window !== "undefined" ? ((window as unknown as { brainyNative?: Native }).brainyNative ?? null) : null

export type NativeStatus = { llm: string; speech: string; app: string }

let status: Promise<NativeStatus | null> | undefined
export function nativeStatus(): Promise<NativeStatus | null> {
  return status ??= (async () => {
    const n = native()
    if (!n) return null
    try { return await n.call<NativeStatus>("status") } catch { return null }
  })()
}
