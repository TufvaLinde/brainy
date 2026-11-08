import { getImage } from "@/lib/db"
import { imageType } from "@/lib/files"

/** An image kept with an article, such as an EPUB's. Its address is the hash
 *  of its bytes, so what is served there never changes; its type is read from
 *  them, so it is only ever a picture, whatever the file it came in claimed.
 *  An SVG opened on its own, not shown as a picture, is a document of this
 *  site: sandboxed, it runs no script and loads nothing. */
export async function GET(_: Request, { params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params
  const bytes = /^[0-9a-f]{64}$/.test(hash) ? await getImage(hash) : null
  const type = bytes && imageType(bytes)
  if (!bytes || !type) return new Response(null, { status: 404 })
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": type,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; sandbox",
    },
  })
}
