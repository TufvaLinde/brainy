/**
 * The library as one zip, and back. library.json holds every article as it is
 * kept (see KeptArticle in lib/db), with where it is, how far it was read and
 * its highlights, and the feeds subscribed to; beside it are each article's source and pictures, as files
 * of their own, and each article as Markdown, to read without this app. The
 * trash is left out.
 *
 * A zip is written as the download reads it, and read back from the bucket by
 * the ranges its files are at, never whole, so an archive can be as large as
 * its library: its sizes and offsets are ZIP64's eight bytes. Only text is
 * compressed, outside the server's thread; pictures and recordings are already.
 * Restoring adds the articles a library doesn't hold yet, as they were.
 */
import { promisify } from "node:util"
import { crc32, deflateRaw, inflateRaw } from "node:zlib"
import * as db from "@/lib/db"
import { ImportError, MAX_BYTES, Pictures } from "@/lib/files"
import { highlightsMarkdown, type Highlight } from "@/lib/highlights"
import { render, wordCount } from "@/lib/markdown"
import * as storage from "@/lib/storage"

/** The archive's own format, raised with any change to what library.json
 *  holds. One of version 2, from before feeds and notes on articles, restores
 *  all the same. */
const VERSION = 3

type Listed = Omit<db.KeptArticle, "source"> & { source: (NonNullable<db.KeptArticle["source"]> & { path: string }) | null }

/** An article as Markdown: its title, where it came from, its text, the note on it, and its highlights with theirs. */
export function articleMarkdown(article: {
  title: string; url: string; markdown: string; note: string | null; highlights: Pick<Highlight, "quote" | "note">[]
}): string {
  const source = /^https?:/.test(article.url) ? `Source: ${article.url}\n\n` : ""
  const note = article.note ? `\n\n## Note\n\n${article.note}` : ""
  const notes = highlightsMarkdown(article.highlights)
  return `# ${article.title}\n\n${source}${article.markdown}${note}${notes && `\n\n## Highlights and notes\n\n${notes}`}\n`
}

/** A title as a name a file can have on any system. */
const fileName = (title: string) => title.replace(/[\u0000-\u001f/\\:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80)

/** The types of sources that are text, compressed as Markdown and library.json are. */
const TEXT = /^(text|message|multipart)\/|[+/](json|xml)\b/

/** The library as a zip, read from the database an article at a time as the
 *  download takes it. */
export function libraryArchive(): ReadableStream<Uint8Array> {
  const chunks = zipped(files())
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await chunks.next()
      if (done) controller.close()
      else controller.enqueue(value)
    },
  })
}

/** A file for a zip: text, held whole to be deflated, or bytes stored as they come. */
type ZipFile = { path: string } & ({ text: Uint8Array } | { parts: Iterable<Uint8Array> | AsyncIterable<Uint8Array> })

/** The library's files, an article at a time: its source, pictures and
 *  Markdown; and last, library.json, which lists them. */
async function* files(): AsyncGenerator<ZipFile> {
  const listed: Listed[] = []
  const pictures = new Set<string>()
  for (const [n, id] of (await db.keptIds()).entries()) {
    const kept = await db.keptArticle(id)
    if (!kept) continue
    const { article: { source, ...article }, files } = kept
    const name = `${n + 1} ${fileName(article.title)}`
    const path = source && `sources/${name}/${fileName(source.name) || "source"}`
    if (source && path) {
      // A recording can be gigabytes, and goes a part at a time; text is never over MAX_BYTES.
      yield TEXT.test(source.type) ? { path, text: Buffer.concat(await Array.fromAsync(files.source!)) } : { path, parts: files.source! }
    }
    for (const image of files.images) {
      if (pictures.has(image.hash)) continue
      pictures.add(image.hash)
      yield { path: `images/${image.hash}`, parts: [image.bytes] }
    }
    if (article.markdown !== null) {
      // Its pictures are beside it in the zip, not on this site.
      const markdown = articleMarkdown({ ...article, markdown: article.markdown }).replaceAll("](/images/", "](../images/")
      yield { path: `articles/${name}.md`, text: Buffer.from(markdown) }
    }
    listed.push({ ...article, source: source && path ? { ...source, path } : null })
  }
  const library = { version: VERSION, exportedAt: new Date(), feeds: await db.listFeeds(), articles: listed }
  yield { path: "library.json", text: Buffer.from(JSON.stringify(library, null, 2)) }
}

const LOCAL = 0x04034b50
const CENTRAL = 0x02014b50
const END = 0x06054b50
const ZIP64_END = 0x06064b50
const ZIP64_LOCATOR = 0x07064b50
const STORED = 0
const DEFLATED = 8
const deflate = promisify(deflateRaw)
const inflate = promisify(inflateRaw)

/** A time as a zip has it, in two-second steps: its time of day in two bytes,
 *  then its date, from 1980, in two. */
const dosTime = (date: Date) =>
  (((date.getFullYear() - 1980) << 25) | ((date.getMonth() + 1) << 21) | (date.getDate() << 16) |
    (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) >>> 0

/** A zip written a file at a time as it is read. A file's checksum and sizes
 *  follow it, as they are known only once it is written, and every size and
 *  offset is in ZIP64's eight bytes, as a library can pass 4 GB. */
async function* zipped(files: AsyncIterable<ZipFile>): AsyncGenerator<Uint8Array> {
  const time = dosTime(new Date())
  const directory: Buffer[] = []
  let offset = 0
  for await (const file of files) {
    const name = Buffer.from(file.path)
    const method = "text" in file ? DEFLATED : STORED
    const header = Buffer.alloc(30 + name.length + 20)
    header.writeUInt32LE(LOCAL, 0)
    header.writeUInt16LE(45, 4) // The version that reads ZIP64.
    header.writeUInt16LE(0x0808, 6) // Sizes after the bytes; a UTF-8 name.
    header.writeUInt16LE(method, 8)
    header.writeUInt32LE(time, 10)
    header.writeUInt32LE(0xffffffff, 18)
    header.writeUInt32LE(0xffffffff, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(20, 28)
    name.copy(header, 30)
    // ZIP64's sizes, which come after the bytes, and say they are eight bytes there.
    header.writeUInt16LE(1, 30 + name.length)
    header.writeUInt16LE(16, 32 + name.length)
    yield header

    let crc = 0
    let size = 0
    let stored = 0
    if ("text" in file) {
      const deflated = await deflate(file.text)
      ;[crc, size, stored] = [crc32(file.text), file.text.length, deflated.length]
      yield deflated
    } else {
      for await (const part of file.parts) {
        crc = crc32(part, crc)
        size += part.length
        yield part
      }
      stored = size
    }
    const sizes = Buffer.alloc(24)
    sizes.writeUInt32LE(0x08074b50, 0)
    sizes.writeUInt32LE(crc, 4)
    sizes.writeBigUInt64LE(BigInt(stored), 8)
    sizes.writeBigUInt64LE(BigInt(size), 16)
    yield sizes

    const entry = Buffer.alloc(46 + name.length + 28)
    entry.writeUInt32LE(CENTRAL, 0)
    entry.writeUInt16LE(45, 4)
    entry.writeUInt16LE(45, 6)
    entry.writeUInt16LE(0x0808, 8)
    entry.writeUInt16LE(method, 10)
    entry.writeUInt32LE(time, 12)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(0xffffffff, 20)
    entry.writeUInt32LE(0xffffffff, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt16LE(28, 30)
    entry.writeUInt32LE(0xffffffff, 42)
    name.copy(entry, 46)
    entry.writeUInt16LE(1, 46 + name.length)
    entry.writeUInt16LE(24, 48 + name.length)
    entry.writeBigUInt64LE(BigInt(size), 50 + name.length)
    entry.writeBigUInt64LE(BigInt(stored), 58 + name.length)
    entry.writeBigUInt64LE(BigInt(offset), 66 + name.length)
    directory.push(entry)
    offset += header.length + stored + sizes.length
  }
  yield* directory

  const length = directory.reduce((total, entry) => total + entry.length, 0)
  const end = Buffer.alloc(56 + 20 + 22)
  end.writeUInt32LE(ZIP64_END, 0)
  end.writeBigUInt64LE(44n, 4)
  end.writeUInt16LE(45, 12)
  end.writeUInt16LE(45, 14)
  end.writeBigUInt64LE(BigInt(directory.length), 24)
  end.writeBigUInt64LE(BigInt(directory.length), 32)
  end.writeBigUInt64LE(BigInt(length), 40)
  end.writeBigUInt64LE(BigInt(offset), 48)
  end.writeUInt32LE(ZIP64_LOCATOR, 56)
  end.writeBigUInt64LE(BigInt(offset + length), 64)
  end.writeUInt32LE(1, 72)
  // The end every zip has, whose counts, size and offset say to read ZIP64's.
  end.writeUInt32LE(END, 76)
  end.fill(0xff, 84, 96)
  yield end
}

/** Where a file is in a zip, as its directory says; fields, how long its name
 *  and extra fields are there, which those of its own header seldom pass by much. */
type Entry = { path: string; method: number; compressed: number; size: number; offset: number; fields: number }

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
const damaged = (path: string) => new ImportError(`That archive is damaged: ${path} is missing or altered`)

/** The files of an uploaded zip, by name, as the directory at its end lists
 *  them, ZIP64's eight-byte sizes and offsets read where the four bytes are
 *  all ones; none if it is no zip. */
async function entriesOf(upload: string): Promise<Map<string, Entry> | null> {
  // The end record, after which only its comment, of at most 64 KB, can come.
  const tail = view(await storage.uploadBytes(upload, `-${22 + 0xffff}`))
  let end = tail.byteLength - 22
  while (end >= 0 && tail.getUint32(end, true) !== END) end--
  if (end < 0) return null
  let [count, length, offset] = [tail.getUint16(end + 10, true), tail.getUint32(end + 12, true), tail.getUint32(end + 16, true)]
  if (count === 0xffff || length === 0xffffffff || offset === 0xffffffff) {
    if (end < 20 || tail.getUint32(end - 20, true) !== ZIP64_LOCATOR) return null
    const at = Number(tail.getBigUint64(end - 12, true))
    const record = view(await storage.uploadBytes(upload, `${at}-${at + 55}`))
    if (record.getUint32(0, true) !== ZIP64_END) return null
    ;[count, length, offset] = [32, 40, 48].map((field) => Number(record.getBigUint64(field, true)))
  }
  const bytes = await storage.uploadBytes(upload, `${offset}-${offset + length - 1}`)
  const directory = view(bytes)
  const entries = new Map<string, Entry>()
  for (let at = 0, n = 0; n < count; n++) {
    if (directory.getUint32(at, true) !== CENTRAL) return null
    const [names, extras, comment] = [28, 30, 32].map((field) => directory.getUint16(at + field, true))
    const path = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + names))
    const entry = { path, method: directory.getUint16(at + 10, true), compressed: directory.getUint32(at + 20, true),
      size: directory.getUint32(at + 24, true), offset: directory.getUint32(at + 42, true), fields: names + extras }
    for (let field = at + 46 + names; field < at + 46 + names + extras; field += 4 + directory.getUint16(field + 2, true)) {
      if (directory.getUint16(field, true) !== 1) continue
      let value = field + 4
      for (const key of ["size", "compressed", "offset"] as const) {
        if (entry[key] !== 0xffffffff) continue
        entry[key] = Number(directory.getBigUint64(value, true))
        value += 8
      }
    }
    entries.set(path, entry)
    at += 46 + names + extras + comment
  }
  return entries
}

/** Where a file's bytes start in a zip: after its own header, whose name and
 *  extra fields needn't be as long as the directory's. */
async function startOf(upload: string, entry: Entry): Promise<number> {
  const header = view(await storage.uploadBytes(upload, `${entry.offset}-${entry.offset + 29}`))
  if (header.byteLength < 30 || header.getUint32(0, true) !== LOCAL) throw damaged(entry.path)
  return entry.offset + 30 + header.getUint16(26, true) + header.getUint16(28, true)
}

/** A file in an uploaded zip, inflated if it was deflated, of at most
 *  MAX_BYTES; read with its header, unless that is much longer than the
 *  directory's fields, as the bucket is far, and an archive has thousands. */
async function contentsOf(upload: string, entry: Entry): Promise<Uint8Array> {
  if (!entry.compressed) return new Uint8Array()
  const read = await storage.uploadBytes(upload, `${entry.offset}-${entry.offset + 30 + entry.fields + 1024 + entry.compressed - 1}`)
  const header = view(read)
  if (read.length < 30 || header.getUint32(0, true) !== LOCAL) throw damaged(entry.path)
  const start = 30 + header.getUint16(26, true) + header.getUint16(28, true)
  const bytes = start + entry.compressed <= read.length ? read.subarray(start, start + entry.compressed)
    : await storage.uploadBytes(upload, `${entry.offset + start}-${entry.offset + start + entry.compressed - 1}`)
  return entry.method === DEFLATED ? inflate(bytes, { maxOutputLength: MAX_BYTES }) : bytes
}

/** An upload restored as a library's archive, if it is one: a zip, by its
 *  first bytes, that holds library.json. The articles the library doesn't
 *  hold yet are added, an article at a time, each with every file it lists:
 *  its pictures, each at the hash of its bytes, and its source, which the
 *  bucket checks against the hash library.json gives as it is kept; then the
 *  feeds it doesn't subscribe to yet. */
export async function restoreLibrary(upload: string, head: Uint8Array): Promise<boolean> {
  const zip = head.length >= 4 && view(head).getUint32(0, true) === LOCAL
  // A zip whose directory runs past its bytes is no archive either.
  const entries = zip ? await entriesOf(upload).catch((error) => { if (error instanceof RangeError) return null; throw error }) : null
  const listing = entries?.get("library.json")
  if (!entries || !listing) return false
  const json = new TextDecoder().decode(await contentsOf(upload, listing))
  let library: { version: number; articles: Listed[]; feeds?: { url: string; listed: string[] }[] }
  try { library = JSON.parse(json) } catch { throw new ImportError("That archive's library.json couldn't be read") }
  if (library.version !== VERSION && library.version !== 2) throw new ImportError("That archive is from another version of Reader")
  const file = (path: string) => {
    const entry = entries.get(path)
    if (!entry) throw damaged(path)
    return entry
  }
  const restore = async (article: Listed) => {
    const pictures = new Pictures()
    await Promise.all(article.images.map(async ({ hash, url }) => {
      const entry = file(`images/${hash}`)
      if (pictures.address(await contentsOf(upload, entry), url ?? undefined) !== `/images/${hash}`) throw damaged(entry.path)
    }))
    const source = article.source && file(article.source.path)
    // The hash names its file in the bucket, so is nothing else.
    const hash = article.source?.hash ?? ""
    if (source && !/^[0-9a-f]{64}$/.test(hash)) throw damaged(source.path)
    const keepSource = source && (async (id: number) => {
      const start = source.method === DEFLATED ? 0 : await startOf(upload, source)
      const parts = source.method === DEFLATED ? [await contentsOf(upload, source)] : await storage.uploadParts(upload, start, start + source.size - 1)
      await storage.putParts(id, hash, source.size, parts)
      return hash
    })
    const { html, text } = article.markdown === null ? { html: "", text: "" } : render(article.markdown)
    await db.restoreArticle(article, keepSource, pictures.images, { html, text, words: wordCount(text) })
  }
  // Four articles at a time, as each waits on the bucket and the database in
  // turn, holding one of the five connections to it; once one fails, the
  // others stop with the article they are on. Wait for all of them before
  // returning, so the caller cannot remove the upload while they still read it.
  const articles = library.articles.values()
  let failed = false
  const results = await Promise.allSettled(Array.from({ length: 4 }, async () => {
    for (const article of articles) {
      if (failed) return
      await restore(article).catch((error) => {
        failed = true
        throw error
      })
    }
  }))
  const rejected = results.find(result => result.status === "rejected")
  if (rejected) throw rejected.reason
  await db.restoreFeeds(library.feeds ?? [])
  return true
}
