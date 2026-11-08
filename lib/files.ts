/**
 * What every reader of a file shares: the size limit, and bytes read within
 * it; text in its own encoding, and as HTML; zips opened within a limit of
 * their own; pictures told by their bytes and kept at addresses of their own;
 * converters run where they can be stopped; and failures said plainly.
 * Server-only.
 */

import { isUtf8 } from "node:buffer"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { unzipSync } from "fflate"
import type { EmbeddedImage } from "@/lib/db"

/** The most a file may be that is read whole, as a document, a book, a page
 *  or a library's archive is to be read, taking about twice its size while it
 *  is. Only a recording is kept larger, as it is never read whole (see lib/storage). */
export const MAX_BYTES = 1024 * 1024 * 1024

/** The most a zip may hold, inflated: a book's chapters and pictures, or an
 *  archived article's source and the pictures read out of it. */
const MAX_UNZIPPED = 2 * MAX_BYTES

/** An import failure that can be shown directly to the reader. */
export class ImportError extends Error {}
export class SizeLimit extends ImportError {}

/** What a response or a request sends, stopped at the limit, whatever it said it would send. */
export async function readBytes(response: Pick<Response, "headers" | "body">, limit = MAX_BYTES): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel().catch(() => {})
    throw new SizeLimit("That is too large to save")
  }
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > limit) throw new SizeLimit("That is too large to save")
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks, length)
}

/** A zip's files, or only those named, at most MAX_UNZIPPED of them in all. A
 *  deflated file is inflated into the size the zip declares for it, and comes
 *  out cut short if it understates it; a stored one is as long as it is in the
 *  zip, whatever it declares. So each counts as the larger of the two. */
export function unzip(bytes: Uint8Array, only?: string[]): Record<string, Uint8Array> {
  const wanted = only && new Set(only)
  let total = 0
  return unzipSync(bytes, {
    filter: (file) => {
      if (wanted && !wanted.has(file.name)) return false
      total += Math.max(file.size, file.originalSize)
      if (total > MAX_UNZIPPED) throw new SizeLimit("The archive expands beyond the reader's size limit")
      return true
    },
  })
}

/** The names of the files in a zip, none of them inflated; none if it is no zip. */
export function namesIn(bytes: Uint8Array): Set<string> {
  const names = new Set<string>()
  try {
    unzipSync(bytes, {
      filter: (file) => {
        names.add(file.name)
        return false
      },
    })
  } catch {}
  return names
}

/** The encoding text is in, as browsers read it: the one its byte order mark
 *  names, or else the server or the page itself declares; declaring none,
 *  UTF-8, if it is that, or else Windows-1252, as an older file often is. */
export function encodingOf(bytes: Uint8Array, type: string): string {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048))
  const marked =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? "utf-8"
      : bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : null
  return (
    marked ??
    /charset=["']?([\w-]+)/i.exec(type)?.[1] ??
    /(?:<meta[^>]+charset|<\?xml[^>]+encoding)=["']?([\w-]+)/i.exec(head)?.[1] ??
    (isUtf8(bytes) ? "utf-8" : "windows-1252")
  )
}

/** Bytes as text, in their encoding; Response.text() would read every page as UTF-8. */
export function decode(bytes: Uint8Array, type: string): string {
  try {
    return new TextDecoder(encodingOf(bytes, type)).decode(bytes)
  } catch {
    return new TextDecoder().decode(bytes)
  }
}

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }
export const escapeHtml = (text: string): string => text.replace(/[&<>"]/g, character => ENTITIES[character])

/** Plain text as HTML paragraphs: a blank line ends one, and the lines it was
 *  wrapped into are joined again. */
export function paragraphsOf(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim().replace(/\s*\n\s*/g, " "))
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("")
}

/** A picture's type, by its first bytes, or an SVG's by its root element.
 *  An SVG can hold a script, which never runs where a page shows it as a
 *  picture, and is sandboxed where one is opened on its own (see app/images). */
export function imageType(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, 32))
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png"
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg"
  if (/^GIF8[79]a/.test(head.toString("latin1"))) return "image/gif"
  if (head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") return "image/webp"
  if (head.toString("ascii", 4, 8) === "ftyp" && /avif|avis/.test(head.toString("ascii", 8))) return "image/avif"
  if (head.toString("ascii", 0, 2) === "BM") return "image/bmp"
  const text = new TextDecoder().decode(bytes.subarray(0, 4096))
  if (/^\s*(?:<\?xml[^>]*>\s*)?(?:(?:<!--[\s\S]*?-->|<!doctype[^>]*>)\s*)*<svg[\s>]/i.test(text)) return "image/svg+xml"
  return null
}

/** The pictures inside a file, each kept to be served at /images/ and the hash of its bytes. */
export class Pictures {
  private kept = new Map<string, EmbeddedImage>()

  get images(): EmbeddedImage[] {
    return [...this.kept.values()]
  }

  /** Where these bytes will be served, if they are a raster picture; url is
   *  where they were downloaded from, if they were. */
  address(bytes: Uint8Array | undefined, url?: string): string | null {
    if (!bytes || !imageType(bytes)) return null
    const hash = createHash("sha256").update(bytes).digest("hex")
    // Once for each address it came from, so reading again finds it at any of them.
    this.kept.set(`${hash} ${url ?? ""}`, { hash, bytes, url })
    return `/images/${hash}`
  }

  /** Each <img> pointed at the kept copy of the picture its src names in the
   *  file. One on the web is left as it is; any other leads nowhere, and goes. */
  point(root: ParentNode, bytesAt: (src: string) => Uint8Array | undefined): void {
    for (const img of root.querySelectorAll("img")) {
      const src = img.getAttribute("src") ?? ""
      const address = this.address(bytesAt(src))
      if (address) img.setAttribute("src", address)
      else if (!/^https?:\/\//i.test(src)) img.remove()
    }
  }
}

/** An SVG that draws pictures by where they are in a book, drawing them from
 *  within instead: shown as a picture of its own, it has no book around it. */
export function selfContained(svg: string, bytesAt: (href: string) => Uint8Array | undefined): Uint8Array {
  const within = svg.replace(/\bhref=(["'])(.*?)\1/g, (named, _quote: string, href: string) => {
    const drawn = bytesAt(href)
    const type = drawn && imageType(drawn)
    return type ? `href="data:${type};base64,${Buffer.from(drawn).toString("base64")}"` : named
  })
  return new TextEncoder().encode(within)
}

/** A converter's result, from code of its own in a process of its own, sent
 *  what it reads as a message and answering with one: WASM or a parser can
 *  block for minutes, and only a process can be stopped part-way, run out of
 *  memory alone, or set V8's flags without setting the server's. One is
 *  stopped after five minutes, as long as a claim to read an article lasts
 *  (see db.claimWork): Pandoc takes about four seconds a megabyte of text. */
export async function inProcess<T>(code: string, data: object): Promise<T> {
  const converter = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "inherit", "inherit", "ipc"], serialization: "advanced" })
  let timer: NodeJS.Timeout | undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Conversion took longer than five minutes")), 5 * 60_000)
      converter.once("message", (result: T & { error?: string }) => (result.error ? reject(new Error(result.error)) : resolve(result)))
      converter.once("error", reject)
      converter.once("exit", (code) => reject(new Error(`The converter stopped (${code})`)))
      converter.send(data)
    })
  } finally {
    clearTimeout(timer)
    converter.kill("SIGKILL")
  }
}
