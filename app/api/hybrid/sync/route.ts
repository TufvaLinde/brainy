import { after } from "next/server"
import { maybeRelabel } from "@/lib/hybrid/agent"
import { addEvents, profile, recentEvents } from "@/lib/hybrid/store"
import type { DeviceEvent } from "@/lib/hybrid/types"

export const maxDuration = 300

const KINDS = new Set(["asked", "suggested", "accepted", "swiped", "opened", "read", "closed", "signal"])
const valid = (e: DeviceEvent) => typeof e?.id === "string" && e.id.length <= 64 && typeof e.device === "string" &&
  Number.isFinite(e.at) && KINDS.has(e.kind) && typeof e.moment === "object" && (e.articleId === undefined || Number.isInteger(e.articleId))

/** A device's outbox, handed over whenever it is online: its events go to the
 *  agent, which redraws the sphere once enough are new; the answer is the
 *  sphere as it stands and what other devices and the phone's automations reported. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  const events: DeviceEvent[] = Array.isArray(body?.events) ? body.events.slice(0, 500) : []
  if (!events.every(valid)) return Response.json({ error: "Send events as the app makes them" }, { status: 400 })
  const accepted = await addEvents(events)
  if (accepted || body?.relabel) after(() => maybeRelabel(Boolean(body?.relabel)).then(() => {}))
  const since = Number(body?.since) || Date.now() - 6 * 3600_000
  const signals = (await recentEvents(60)).filter(e => e.kind === "signal" && e.at > since)
  return Response.json({ accepted, profile: await profile(), signals })
}
