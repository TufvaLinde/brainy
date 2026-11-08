import { isLink, savePage } from "@/lib/library"
import { ImportError, MAX_BYTES, readBytes, SizeLimit } from "@/lib/files"

/** Where the bookmarklet sends the page open in the browser, as it has it.
 *  Then it opens what was saved, or the library, if it couldn't be read,
 *  with the reason why. Files go to the bucket instead, straight from the
 *  browser (see uploadTargets in app/actions). */
export async function POST(request: Request) {
  let form: FormData | null
  try {
    const bytes = await readBytes(request, MAX_BYTES + 1024 * 1024)
    form = await new Response(new Uint8Array(bytes), { headers: request.headers }).formData().catch(() => null)
  } catch (error) {
    if (!(error instanceof SizeLimit)) return new Response("The upload was interrupted", { status: 400 })
    return new Response(null, { status: 303, headers: { location: `/?${new URLSearchParams({ error: "That page is over 1 GB" })}` } })
  }
  const url = String(form?.get("url") ?? "")
  const html = String(form?.get("html") ?? "")
  if (!(isLink(url) && html)) return new Response("Send a page's url and html", { status: 400 })

  let to: string
  try {
    if (Buffer.byteLength(html) > MAX_BYTES) throw new ImportError("That page is over 1 GB")
    to = `/read/${await savePage(url, html)}`
  } catch (error) {
    if (!(error instanceof ImportError)) throw error
    to = `/?${new URLSearchParams({ error: error.message })}`
  }
  // Relative, so the browser stays at the address it posted to: localhost
  // and 127.0.0.1 keep apart what each remembers.
  return new Response(null, { status: 303, headers: { location: to } })
}
