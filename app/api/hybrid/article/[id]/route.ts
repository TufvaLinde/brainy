import { getArticle } from "@/lib/db"

/** An item's reading, which the device keeps to open offline. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const article = /^\d{1,9}$/.test(id) ? await getArticle(Number(id), "html") : null
  if (!article) return Response.json({ error: "No such item" }, { status: 404 })
  const original = article.format ? `/read/${article.id}/original` : null
  return Response.json({
    id: article.id, title: article.title, site: article.site, byline: article.byline, url: article.url,
    minutes: article.minutes, html: article.reading, type: article.type, original,
  }, { headers: { "cache-control": "private, max-age=3600" } })
}
