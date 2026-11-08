/** A thread articles are read in, one at a time, as lib/library sends them. */
import { parentPort } from "node:worker_threads"
import type { Source } from "@/lib/db"
import { ImportError } from "@/lib/files"
import { read } from "@/lib/library"

parentPort!.on("message", async ({ source, kept, capture }: { source: Source; kept: Map<string, string>; capture: boolean }) => {
  try {
    parentPort!.postMessage({ reading: await read(source, kept, capture) })
  } catch (error) {
    parentPort!.postMessage({ error, expected: error instanceof ImportError })
  }
})
