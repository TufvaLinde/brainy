/** Email, and pages saved whole as MHTML, both MIME messages, as HTML with their pictures. */
import { parseHTML } from "linkedom"
import PostalMime from "postal-mime"
import type { EmbeddedImage } from "@/lib/db"
import { Pictures } from "@/lib/files"

type Mail = {
  subject: string
  sender: string
  date: Date | null
  /** Where a saved page was saved from. */
  url: string | null
  images: EmbeddedImage[]
} & ({ html: string } | { text: string })

/** Read email or MHTML and resolve embedded cid: images. */
export async function mailToHtml(bytes: Uint8Array): Promise<Mail> {
  const mail = await PostalMime.parse(bytes)
  if (!mail.html && !mail.text) throw new Error("The message has no text")
  const date = new Date(mail.date ?? "")
  const about = {
    subject: mail.subject?.trim() ?? "",
    sender: mail.from?.name || mail.from?.address || "",
    date: Number.isNaN(date.getTime()) ? null : date,
    url: mail.headers.find((header) => header.key === "snapshot-content-location")?.value ?? null,
  }
  if (!mail.html) return { ...about, text: mail.text!, images: [] }

  const parts = new Map<string, Uint8Array>(
    mail.attachments.flatMap((part) =>
      part.contentId && typeof part.content !== "string"
        ? [[`cid:${part.contentId.replace(/^<|>$/g, "")}`, new Uint8Array(part.content)]]
        : [],
    ),
  )
  const { document } = parseHTML(mail.html)
  const pictures = new Pictures()
  pictures.point(document, (src) => parts.get(src))
  // A page saved whole keeps its pictures' addresses on the web, which they are kept by (see lib/library).
  for (const [location, part] of partsByLocation(bytes)) pictures.address(part, location)
  return { ...about, html: document.toString(), images: pictures.images }
}

/** A message's parts by the address each names: a page saved whole names
 *  its pictures by where they were saved from, as Chrome does, in a
 *  Content-Location, which postal-mime doesn't read. */
function partsByLocation(bytes: Uint8Array): Map<string, Uint8Array> {
  const text = Buffer.from(bytes).toString("latin1")
  const boundary = /boundary="?([^";\r\n]+)/i.exec(text.slice(0, text.search(/\r?\n\r?\n/)))?.[1]
  const parts = new Map<string, Uint8Array>()
  for (const part of boundary ? text.split(`--${boundary}`).slice(1) : []) {
    const end = /\r?\n\r?\n/.exec(part)
    const head = part.slice(0, end?.index).replace(/\r?\n[ \t]+/g, "")
    const location = /^content-location:\s*(\S+)/im.exec(head)?.[1]
    if (!end || !location) continue
    const body = part.slice(end.index + end[0].length)
    parts.set(location, Buffer.from(body, /^content-transfer-encoding:\s*base64/im.test(head) ? "base64" : "latin1"))
  }
  return parts
}
