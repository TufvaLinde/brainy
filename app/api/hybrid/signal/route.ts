import { addEvents } from "@/lib/hybrid/store"
import type { Moment } from "@/lib/hybrid/types"

const daypart = (hour: number): Moment["daypart"] =>
  hour < 5 ? "night" : hour < 11 ? "morning" : hour < 14 ? "midday" : hour < 18 ? "afternoon" : hour < 22 ? "evening" : "night"

/** Something the phone reports through an iOS Shortcuts automation, which a
 *  web app can't see for itself: an app opened, a Focus turned on. For example
 *  /api/hybrid/signal?app=Instagram or ?focus=Work. */
async function handle(request: Request) {
  const url = new URL(request.url)
  const form = request.method === "POST" ? await request.json().catch(() => ({})) : {}
  const get = (key: string) => String(form[key] ?? url.searchParams.get(key) ?? "").slice(0, 80) || undefined
  const app = get("app"), focus = get("focus"), note = get("note")
  if (!app && !focus && !note) return Response.json({ error: "Say which app, focus or note" }, { status: 400 })
  const zone = get("tz") ?? "America/Los_Angeles"
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: zone }).format(new Date()))
  await addEvents([{
    id: crypto.randomUUID(), device: get("device") ?? "shortcuts", at: Date.now(), kind: "signal",
    moment: { daypart: daypart(hour), energy: null, moods: [], setting: null, device: "phone", online: true },
    data: { app, focus, note },
  }])
  return Response.json({ ok: true })
}
export const GET = handle
export const POST = handle
