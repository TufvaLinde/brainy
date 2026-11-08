import { setProgress } from "@/lib/db"

/** A route, not an action, as only a keepalive request outlives the tab
 *  closing. Only for this site's own pages: by the Host header, the address
 *  the browser asked for, as Next may give request.url as localhost. */
export async function POST(request: Request) {
  const origin = request.headers.get("origin")
  if (origin && URL.parse(origin)?.host !== request.headers.get("host")) return new Response(null, { status: 403 })
  const { id, progress, updatedAt } = (await request.json().catch(() => null)) ?? {}
  const valid = Number.isInteger(id) && Number.isFinite(progress) && Number.isSafeInteger(updatedAt) && updatedAt <= Date.now() + 60_000
  if (!valid) return new Response(null, { status: 400 })
  await setProgress(id, progress, updatedAt)
  return new Response(null, { status: 204 })
}
