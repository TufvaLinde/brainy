import { getArticle, getOriginal } from "@/lib/db"
import { articleMarkdown } from "@/lib/archive"
import { address } from "@/lib/storage"

/** An imported file as it came, or with ?format=markdown, the article as
 *  Markdown. What a browser shows safely, a PDF, a picture, a recording or
 *  plain text, opens in it, unless ?download; anything else, above all HTML,
 *  SVG and XML, which could run scripts, downloads, to open in its own app.
 *  A file is read from the bucket itself, which answers the ranges a player
 *  asks for, however large it is. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^\d{1,9}$/.test(id)) return new Response(null, { status: 404 })
  const { searchParams } = new URL(request.url)
  const exporting = searchParams.get("format") === "markdown"
  const file = exporting ? await markdownOf(Number(id)) : await getOriginal(Number(id))
  if (!file) return new Response(null, { status: 404 })

  const type = file.type.split(";", 1)[0].toLowerCase()
  const shown = /^(?:application\/pdf|image\/(?:png|jpeg|gif|webp|avif|bmp)|audio\/(?:mpeg|aac|wav|flac|ogg|mp4)|video\/(?:ogg|webm|quicktime|mp4)|text\/(?:plain|markdown|csv|tab-separated-values))$/.test(type)
  const inline = shown && !exporting && !searchParams.has("download")
  const name = file.name.split(/[\\/]/).pop()?.toWellFormed() || "original"
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_")
  // RFC 5987 leaves out the characters encodeURIComponent keeps.
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  const served = shown ? file.type : "application/octet-stream"
  const disposition = `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`
  if ("hash" in file) return Response.redirect(await address(Number(id), file.hash, served, disposition), 307)
  return new Response(file.text, {
    headers: {
      "content-type": served,
      "content-disposition": disposition,
      "x-content-type-options": "nosniff",
      // Re-saving the article can replace what is written at this same address.
      "cache-control": "private, no-cache",
    },
  })
}

/** The article as Markdown (see lib/archive), as a file to download. */
async function markdownOf(id: number) {
  const article = await getArticle(id, "markdown")
  if (!article?.reading) return null
  const text = articleMarkdown({ ...article, markdown: article.reading })
  return { name: `${article.title}.md`, type: "text/markdown; charset=utf-8", text }
}
