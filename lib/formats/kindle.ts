/** Kindle books, MOBI and KF8 (AZW3), as HTML with their pictures. */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseHTML } from "linkedom"
import type { EmbeddedImage } from "@/lib/db"
import { imageType, inProcess, MAX_BYTES, Pictures, selfContained } from "@/lib/files"

const KINDLE = `
const { readdir, readFile } = require('node:fs/promises');
const { join } = require('node:path');
process.once('message', data => (async () => {
  const { initMobiFile, initKf8File } = await import('@lingo-reader/mobi-parser');
  const book = await (data.kf8 ? initKf8File : initMobiFile)(data.bytes, data.directory);
  // The reading view has no use for the book's stylesheets, and the parser
  // takes any link in a chapter's head, a canonical URL too, for one of them.
  if (data.kf8) {
    const replace = book.replace.bind(book);
    book.replace = html => replace(html.replace(/<link\\b[^>]*>/gi, ''));
  }
  const metadata = book.getMetadata();
  const chapters = book.getSpine().map(chapter => {
    const loaded = book.loadChapter(chapter.id);
    if (!loaded) throw new Error('A book chapter could not be read');
    return loaded.html;
  });
  if (!chapters.length) throw new Error('The book has no chapters');
  // Written to the directory when asked for, so asked for before it is read.
  const cover = book.getCoverImage();
  const media = await Promise.all((await readdir(data.directory)).map(async name => {
    const path = join(data.directory, name);
    return [path, new Uint8Array(await readFile(path))];
  }));
  process.send({ title: metadata.title, author: metadata.author?.join(', '), cover, chapters, media });
})().catch(error => process.send({ error: error.message })));
`

type Parsed = { title: string; author: string; cover: string; chapters: string[]; media: [string, Uint8Array][] }

/** Read MOBI/KF8 in a process of its own; always remove its temporary images. */
export async function kindleToHtml(
  bytes: Uint8Array,
): Promise<{ title: string; author: string; html: string; images: EmbeddedImage[]; cover: string | null; format: string }> {
  // A Palm database of records, the first holding the book's MOBI header. One
  // of version 8 or later, there or in a later record, makes it KF8, or AZW3.
  if (bytes.length < 86 || Buffer.from(bytes.subarray(60, 68)).toString() !== "BOOKMOBI") throw new Error("Not a MOBI/KF8 book")
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = data.getUint16(76)
  if (!count || 78 + count * 8 > bytes.length) throw new Error("Invalid book records")
  const first = data.getUint32(78)
  if (first + 248 > bytes.length || data.getUint32(first + 4) > MAX_BYTES) throw new Error("Invalid or oversized book")
  let kf8 = data.getUint32(first + 36) >= 8
  for (let index = 0; index < count; index++) {
    const start = data.getUint32(78 + index * 8)
    if (start >= bytes.length) throw new Error("Missing book record")
    if (Buffer.from(bytes.subarray(start + 16, start + 20)).toString() === "MOBI") {
      if (data.getUint16(start + 12)) throw new Error("Encrypted books are not supported")
      if (start + 40 <= bytes.length && data.getUint32(start + 36) >= 8) kf8 = true
    }
  }

  const directory = await mkdtemp(join(tmpdir(), "reader-book-"))
  try {
    const book = await inProcess<Parsed>(KINDLE, { bytes, directory, kf8 })
    const media = new Map(book.media)
    // An SVG, as a cover page is, names the pictures it draws by the files the
    // parser wrote, gone once the book is read; it carries them within instead.
    for (const [path, file] of media) {
      if (imageType(file) === "image/svg+xml") media.set(path, selfContained(new TextDecoder().decode(file), (href) => media.get(href)))
    }
    const pictures = new Pictures()
    const html = book.chapters
      .map((chapter) => {
        const { body } = parseHTML(`<html><body>${chapter}</body></html>`).document
        pictures.point(body, (src) => media.get(src))
        return body.innerHTML
      })
      .join("\n")
    const cover = pictures.address(media.get(book.cover))
    return { title: book.title, author: book.author, html, images: pictures.images, cover, format: kf8 ? "AZW3" : "MOBI" }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
