/** What a file is, told once, here, and the article in it: the simplest
 *  formats read here, each of the others by a module of its own beside this one. */

import { Defuddle } from "defuddle/node"
import { parseHTML } from "linkedom"
import type { ArticleMetadata, EmbeddedImage, Source } from "@/lib/db"
import { decode, encodingOf, escapeHtml, imageType, ImportError, namesIn, paragraphsOf, Pictures, unzip } from "@/lib/files"
import { DOCUMENT_FORMATS, documentToHtml } from "@/lib/formats/documents"
import { epubToHtml } from "@/lib/formats/epub"
import { kindleToHtml } from "@/lib/formats/kindle"
import { mailToHtml } from "@/lib/formats/mail"
import { pdfToHtml } from "@/lib/formats/pdf"

export type ExtractedArticle = ArticleMetadata & ({ html: string } | { markdown: string }) & {
  images?: EmbeddedImage[]
  /** Every picture its page names, the article's or not, to keep as it is saved (see lib/web). */
  pictures?: string[]
  /** For a source worth opening as it came, its format and the type it is served as. */
  original?: { format: string; type: string }
}

const EXTENSIONS = {
  HTML: ["html", "htm", "xhtml"],
  PDF: ["pdf"],
  EML: ["eml"],
  MHTML: ["mht", "mhtml"],
  EPUB: ["epub"],
  Kindle: ["mobi", "azw", "azw3", "kf8"],
  CBZ: ["cbz"],
  Image: ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg"],
  Recording: ["mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "mp4", "m4v", "mov", "webm"],
  Markdown: ["md", "markdown", "mdown", "mkd"],
  Text: ["txt", "text", "xml", "json", "yaml", "yml", "log"],
}

/** What the file picker offers, a zip of exported links and an OPML file of feeds among them (see lib/links). */
export const FILE_ACCEPT = [...Object.values(EXTENSIONS).flat(), ...Object.keys(DOCUMENT_FORMATS), "zip", "opml"]
  .map((extension) => `.${extension}`)
  .join(",")

const UNSUPPORTED =
  "Unsupported file format. Try PDF, EPUB, MOBI/AZW3, CBZ, DOCX, ODT, RTF, PPTX, XLSX, EML, an image, a recording or a text format"

/** A file, read by what it is (see formatOf); url is the link it came from, if any. */
export async function extract({ bytes, name, type, url }: Source): Promise<ExtractedArticle> {
  const base = url ?? ""
  type = type.toLowerCase()
  const extension = /\.(\w+)$/.exec(name)?.[1]?.toLowerCase() ?? ""
  const site = base ? new URL(base).hostname : name
  const titled = (title = "", byline = "") => ({ title: title || name.replace(/\.\w+$/, ""), site, byline: byline || null })
  const original = (format: string, mime: string) => ({ format, type: mime })

  const format = formatOf(bytes, type, extension)
  if (!format) throw new ImportError(UNSUPPORTED)
  switch (format) {
    case "HTML": {
      const text = decode(bytes, type)
      const { document } = parseHTML(text)
      if (base) return readPage(document, base)
      const from = savedFrom(document, text)
      const page = await readPage(document, from ?? undefined)
      return { ...page, title: page.title || titled().title, site: from ? page.site : name, original: original("HTML", "text/html") }
    }
    case "PDF": {
      const { title, author, html } = await opened(() => pdfToHtml(bytes), "That PDF couldn't be opened: it may be damaged or locked")
      return { ...titled(title, author), html, original: original("PDF", "application/pdf") }
    }
    case "EML":
    case "MHTML": {
      const mail = await opened(() => mailToHtml(bytes), "That message couldn't be opened: it may be damaged")
      const kept = format === "EML" ? original("EML", "message/rfc822") : original("MHTML", "multipart/related")
      const page = "html" in mail ? await readPage(parseHTML(mail.html).document, mail.url ?? undefined) : null
      // A page saved whole reads as the page it was saved from; an email, as its message.
      if (format === "MHTML" && mail.url && page) return { ...page, images: mail.images, original: kept }
      return {
        ...titled(mail.subject || page?.title),
        site: mail.sender || site,
        publishedAt: mail.date,
        html: page?.html ?? paragraphsOf("text" in mail ? mail.text : ""),
        images: mail.images,
        original: kept,
      }
    }
    case "EPUB": {
      const { title, author, excerpt, html, images, cover } = await opened(() => epubToHtml(bytes), "That EPUB couldn't be opened: it may be damaged")
      return { ...titled(title, author), excerpt, html, images, image: cover, original: original("EPUB", "application/epub+zip") }
    }
    case "Kindle": {
      const reason = "That book couldn't be opened: it may be damaged, encrypted or unsupported"
      const { title, author, html, images, cover, format } = await opened(() => kindleToHtml(bytes), reason)
      return { ...titled(title, author), html, images, image: cover, original: original(format, "application/x-mobipocket-ebook") }
    }
    case "CBZ": {
      const files = await opened(() => unzip(bytes), "That comic couldn't be opened: it may be damaged")
      const pictures = new Pictures()
      // Its pages in the order their names count, 2.png before 10.png.
      const pages = Object.keys(files)
        .filter((path) => !path.startsWith("__MACOSX/"))
        .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
        .flatMap((path) => pictures.address(files[path]) ?? [])
      if (!pages.length) throw new ImportError("That comic holds no pictures")
      const html = pages.map((address, i) => `<p><img src="${address}" alt="Page ${i + 1}"></p>`).join("\n")
      return { ...titled(), html, images: pictures.images, image: pages[0], original: original("CBZ", "application/vnd.comicbook+zip") }
    }
    case "Image": {
      const mime = imageType(bytes)!
      const pictures = new Pictures()
      const picture = pictures.address(bytes)!
      const html = `<p><img src="${picture}" alt="${escapeHtml(name)}"></p>`
      const kind = mime === "image/svg+xml" ? "SVG" : mime.slice(6).toUpperCase()
      return { ...titled(), html, images: pictures.images, image: picture, original: original(kind, mime) }
    }
    case "Recording":
      return { ...titled(), markdown: "", original: recordingOf(bytes)! }
    case "Markdown": {
      const text = decode(bytes, type)
      // Its title is the heading it opens with, if it opens with one.
      const title = /^# (.+)/.exec(text.trimStart())?.[1]
      // Served in the encoding it was read in, which reading it again goes by too.
      const served = /charset=/.test(type) ? type : `text/markdown; charset=${encodingOf(bytes, type)}`
      return { ...titled(title), markdown: text, original: original("Markdown", served) }
    }
    case "Text": {
      const text = decode(bytes, type)
      if (text.includes("\u0000")) throw new ImportError(UNSUPPORTED)
      // Data is shown as it is written; prose is read as its paragraphs.
      const data = /^(?:json|xml|yaml|yml|log)$/.exec(extension)?.[0] ?? /json|xml|yaml/.exec(type)?.[0]
      if (data) return { ...titled(), html: `<pre>${escapeHtml(text)}</pre>`, original: original(data.toUpperCase(), type || "text/plain") }
      // Its first line is its title, when it is short enough to be one.
      const first = text.trim().split("\n")[0].trim()
      const rest = text.trim().slice(first.length).trim()
      const title = first.length <= 100 && rest ? first : ""
      return { ...titled(title), html: paragraphsOf(title ? rest : text), original: original("Text", type || "text/plain") }
    }
    default: {
      const kind = DOCUMENT_FORMATS[format]
      const kept = original(kind.format, kind.type)
      const converted = await documentToHtml(bytes, kind).catch(() => null)
      if (converted) return { ...titled(converted.title, converted.author), html: converted.html, images: converted.images, original: kept }
      // Markup the converter can't follow is still text, shown as written.
      if (kind.type !== "text/plain") throw new ImportError("That document couldn't be converted: it may be damaged, encrypted or too complex")
      return { ...titled(), html: `<pre>${escapeHtml(decode(bytes, type))}</pre>`, original: kept }
    }
  }
}

/** What a file is: a format of EXTENSIONS, or a document's extension. One
 *  with a signature is told by its first bytes, whatever it is called, and a
 *  zip by the files in it; any other by the type it was sent as, which the
 *  name's extension only stands in for where it is vague, as a page showing a
 *  paper.pdf is HTML. A document goes by its extension first. */
function formatOf(bytes: Uint8Array, type: string, extension: string): string | null {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 128))
  if (head.startsWith("%PDF-")) return "PDF"
  if (imageType(bytes)) return "Image"
  if (head.slice(60, 68) === "BOOKMOBI") return "Kindle"
  if (recordingOf(bytes)) return "Recording"
  if (head.startsWith("PK")) {
    const names = namesIn(bytes)
    // An EPUB's first file, stored as it is, names its type, and so does an ODT's.
    if (head.includes("application/epub+zip") || names.has("META-INF/container.xml")) return "EPUB"
    if (head.includes("application/vnd.oasis.opendocument.text")) return "odt"
    if (names.has("word/document.xml")) return "docx"
    if (names.has("xl/workbook.xml")) return "xlsx"
    if (names.has("ppt/presentation.xml")) return "pptx"
  }

  const vague = !type || /octet-stream|text\/plain|application\/(?:x-)?zip/.test(type)
  const sent = (types: RegExp, extensions: string[]) => types.test(type) || (vague && extensions.includes(extension))
  if (sent(/text\/html|application\/xhtml\+xml/, EXTENSIONS.HTML)) return "HTML"
  if (vague && /^\s*(?:<!doctype html|<html\b)/i.test(decode(bytes.subarray(0, 256), type))) return "HTML"
  if (sent(/pdf/, EXTENSIONS.PDF)) return "PDF"
  if (sent(/^message\/rfc822/, EXTENSIONS.EML)) return "EML"
  if (sent(/^multipart\/related|mimearchive/, EXTENSIONS.MHTML)) return "MHTML"
  if (sent(/epub/, EXTENSIONS.EPUB)) return "EPUB"
  if (sent(/mobipocket|amazon\.ebook/, EXTENSIONS.Kindle)) return "Kindle"
  if (sent(/comicbook/, EXTENSIONS.CBZ)) return "CBZ"
  if (Object.hasOwn(DOCUMENT_FORMATS, extension)) return extension
  const mime = type.split(";", 1)[0].trim()
  const sentAs = Object.keys(DOCUMENT_FORMATS).find((key) => mime !== "text/plain" && DOCUMENT_FORMATS[key].type === mime)
  if (sentAs) return sentAs
  if (sent(/markdown/, EXTENSIONS.Markdown)) return "Markdown"
  if (sent(/^text\/|json|xml|yaml/, EXTENSIONS.Text)) return "Text"
  return null
}

/** Whether a file is a recording, by its first bytes, as one too large to read whole must be. */
export const isRecording = (head: Uint8Array) => formatOf(head, "", "") === "Recording"

/** A recording a browser plays, by its first bytes: its format, and the type
 *  it is served as. A HEIC picture comes in MP4's box, and is none. */
function recordingOf(bytes: Uint8Array): { format: string; type: string } | null {
  const head = Buffer.from(bytes.subarray(0, 64))
  const text = head.toString("latin1")
  // MPEG audio frames sync on 11 bits; layer III is MP3, and ADTS, layer 0, AAC.
  if (text.startsWith("ID3") || (head[0] === 0xff && (head[1] & 0xe6) === 0xe2)) return { format: "MP3", type: "audio/mpeg" }
  if (head[0] === 0xff && (head[1] & 0xf6) === 0xf0) return { format: "AAC", type: "audio/aac" }
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WAVE") return { format: "WAV", type: "audio/wav" }
  if (text.startsWith("fLaC")) return { format: "FLAC", type: "audio/flac" }
  if (text.startsWith("OggS")) return text.includes("theora") ? { format: "OGV", type: "video/ogg" } : { format: "OGG", type: "audio/ogg" }
  if (text.startsWith("\x1a\x45\xdf\xa3") && text.includes("webm")) return { format: "WebM", type: "video/webm" }
  if (text.slice(4, 8) !== "ftyp") return null
  const brand = text.slice(8, 12)
  if (/^M4[ABP] $/.test(brand)) return { format: "M4A", type: "audio/mp4" }
  if (brand === "qt  ") return { format: "MOV", type: "video/quicktime" }
  return /^(?:hei[cmsx]|hev[cx]|mif1|msf1)$/.test(brand) ? null : { format: "MP4", type: "video/mp4" }
}

/** What opening a file gives, or, if it can't be opened, why, said plainly,
 *  unless the opener already said so. */
async function opened<T>(open: () => T | Promise<T>, reason: string): Promise<T> {
  try {
    return await open()
  } catch (error) {
    throw error instanceof ImportError ? error : new ImportError(reason)
  }
}

/** Where a page saved to disk came from, as the page itself, the browser or
 *  SingleFile notes it. */
function savedFrom(document: Document, html: string): string | null {
  const noted =
    document.querySelector('link[rel="canonical"]')?.getAttribute("href") ??
    document.querySelector('meta[property="og:url"]')?.getAttribute("content") ??
    /<!-- saved from url=\(\d+\)(\S+) -->|^ url: (\S+)$/m.exec(html.slice(0, 4096))?.slice(1).find(Boolean)
  return noted && /^https?:\/\//.test(noted) && URL.canParse(noted) ? noted : null
}

/** The article in a page. One with no address of its own, as an email's, is
 *  read at about:blank, where its relative links lead nowhere. */
async function readPage(document: Document, url = "about:blank"): Promise<ExtractedArticle & { html: string }> {
  // linkedom keeps attribute names as written, and an older page's HREF and
  // SRC would be no href or src to Defuddle; only SVG's are cased by design.
  const elements = document.querySelectorAll("*")
  for (const element of elements) {
    for (const { name, value } of Array.from(element.attributes)) {
      if (name === name.toLowerCase() || element.closest("svg")) continue
      element.removeAttribute(name)
      element.setAttribute(name.toLowerCase(), value)
    }
  }
  // Read before Defuddle takes the page apart; data-src is a lazy picture's own.
  const named = Array.from(document.querySelectorAll("img"), (img) => [img.getAttribute("src"), img.getAttribute("data-src")]).flat()
  const pictures = named.flatMap((src) => (src && URL.parse(src, url)?.href) || [])
  // The page's own picture, if it shows it, by host and path, as Defuddle compares pictures.
  const loose = (src: string) => src.replace(/^https?:\/\//, "").split("?")[0]
  const declared = document.querySelector('meta[property="og:image"]')?.getAttribute("content")
  const own = declared && loose(URL.parse(declared, url)?.href ?? declared)
  const shown = own && pictures.some((src) => loose(src) === own) ? own : null
  // Defuddle's pass for read times and boilerplate places each element against
  // others, a time that grows with the square of the page's: over ten minutes
  // for a page of a hundred megabytes. One that long is a document, not an
  // article framed by a site.
  const removeContentPatterns = elements.length < 20_000
  const page = await Defuddle(document, url, { includeReplies: false, useAsync: false, removeContentPatterns })
  const site = new URL(url).hostname
  const published = page.published ? new Date(page.published) : null
  const image = (page.image && URL.parse(page.image, url)?.href) || null
  // Defuddle takes the page's own picture out of the article, for a reading view to
  // show above it, as this one doesn't: one the page showed is put back, first.
  const kept = Array.from(page.content.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g), ([, src]) => loose(src))
  const taken = shown && image && ![shown, loose(image)].some((src) => kept.includes(src))
  return {
    title: page.title || site,
    site: page.site || site,
    // A site that signs its pages with its own name, as Wikipedia does, names no author.
    byline: (page.author !== page.site && page.author) || null,
    image,
    publishedAt: published && !Number.isNaN(published.getTime()) ? published : null,
    excerpt: page.description || null,
    html: taken ? `<p><img src="${escapeHtml(image)}" alt=""></p>${page.content}` : page.content,
    pictures,
  }
}
