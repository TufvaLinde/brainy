import { maybeRelabel } from "@/lib/hybrid/agent"
import { profile } from "@/lib/hybrid/store"

export const maxDuration = 300

/** Redraw the sphere now, for a demo that can't wait for the next few events. */
export async function POST() {
  return Response.json({ profile: (await maybeRelabel(true)) ?? (await profile()) })
}
