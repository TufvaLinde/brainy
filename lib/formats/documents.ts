/** Office documents and markup, read by Pandoc, with their pictures and maths. */
import { strFromU8, strToU8, zipSync } from "fflate"
import { parseHTML } from "linkedom"
import { inProcess, Pictures, unzip } from "@/lib/files"

export type DocumentFormat = { reader: string; format: string; type: string }

/** Documents and markup Pandoc reads, by extension, each with its Pandoc
 *  reader, its name and the type its original is served as. Markup is served
 *  as text, which a browser shows as it is written. */
export const DOCUMENT_FORMATS: Record<string, DocumentFormat> = {
  docx: { reader: "docx", format: "DOCX", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  odt: { reader: "odt", format: "ODT", type: "application/vnd.oasis.opendocument.text" },
  pptx: { reader: "pptx", format: "PPTX", type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  xlsx: { reader: "xlsx", format: "XLSX", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  rtf: { reader: "rtf", format: "RTF", type: "application/rtf" },
  fb2: { reader: "fb2", format: "FB2", type: "application/x-fictionbook+xml" },
  csv: { reader: "csv", format: "CSV", type: "text/csv" },
  tsv: { reader: "tsv", format: "TSV", type: "text/tab-separated-values" },
  ipynb: { reader: "ipynb", format: "IPYNB", type: "application/x-ipynb+json" },
  opml: { reader: "opml", format: "OPML", type: "text/x-opml" },
}
const MARKUP = {
  rst: "rst", rest: "rst", tex: "latex", latex: "latex", org: "org",
  adoc: "asciidoc", asciidoc: "asciidoc", textile: "textile", djot: "djot",
  typ: "typst", typst: "typst", wiki: "mediawiki", mediawiki: "mediawiki",
  dokuwiki: "dokuwiki", creole: "creole", jira: "jira", muse: "muse",
  t2t: "t2t", pod: "pod", man: "man", mdoc: "mdoc", vimwiki: "vimwiki",
  twiki: "twiki", tikiwiki: "tikiwiki", haddock: "haddock",
  docbook: "docbook", dbk: "docbook", jats: "jats",
}
for (const [extension, reader] of Object.entries(MARKUP)) {
  DOCUMENT_FORMATS[extension] = { reader, format: extension.toUpperCase(), type: "text/plain" }
}

// Pandoc's memory grows a megabyte or less at a time, and V8 counts all of it
// again each time as memory newly held outside its heap; past 64 MB more, it
// collects its whole heap, 13 ms with Pandoc loaded. A document of 8 MB of
// text did so over a thousand times, a third of its conversion, and the count
// grows with the square of the text. With the flag, V8 lets that memory grow
// with its heap instead. A Node that lacks it says so, and converts as before.
const PANDOC = `
require('node:v8').setFlagsFromString('--external-memory-accounted-in-global-limit');
process.once('message', ({ bytes, reader }) => (async () => {
  const { convert } = await import('pandoc-wasm');
  const result = await convert({ from: reader, to: 'html5', standalone: true,
    'input-files': ['input'], 'extract-media': 'media', 'html-math-method': { method: 'mathml' }, wrap: 'none' },
    null, { input: new Blob([bytes]) });
  if (!result.stdout.trim()) throw new Error('No readable content was found in this document');
  const media = await Promise.all(Object.entries(result.mediaFiles).map(async ([name, blob]) =>
    [name, new Uint8Array(await blob.arrayBuffer())]));
  process.send({ html: result.stdout, media });
})().catch(error => process.send({ error: error.message })));
`

// One conversion at a time: each process loads all of Pandoc.
let converting: Promise<unknown> = Promise.resolve()

/** Convert office documents and markup with Pandoc, preserving images and maths. */
export async function documentToHtml(bytes: Uint8Array, { reader }: DocumentFormat) {
  // An office document is a zip, unzipped here first to refuse one that would inflate past the limit.
  if (["docx", "odt", "pptx", "xlsx"].includes(reader)) {
    const files = unzip(bytes)
    if (reader === "xlsx") bytes = withSharedStrings(files)
  }
  const job = converting.then(() => inProcess<{ html: string; media: [string, Uint8Array][] }>(PANDOC, { bytes, reader }))
  converting = job.catch(() => {})
  const converted = await job

  const { document } = parseHTML(converted.html)
  const media = new Map(converted.media.map(([path, bytes]) => [path.replace(/^\.?\//, ""), bytes]))
  const pictures = new Pictures()
  pictures.point(document, (src) => {
    try {
      src = decodeURIComponent(src)
    } catch {}
    return media.get(src.replace(/^\.?\//, ""))
  })
  for (const math of document.querySelectorAll("math")) {
    const latex = math.querySelector('annotation[encoding="application/x-tex"]')?.textContent
    if (latex) math.setAttribute("data-latex", latex)
  }
  const title = document.querySelector("h1.title")?.textContent?.trim() ?? ""
  const author = Array.from(document.querySelectorAll('meta[name="author"]'), (meta) => meta.getAttribute("content"))
    .filter(Boolean)
    .join(", ")
  // The title, author and date, which the reading view shows itself.
  document.querySelector("header#title-block-header")?.remove()
  return { title, author, html: document.body.innerHTML, images: pictures.images }
}

/** A workbook whose cells hold their own text, which Pandoc reads as empty,
 *  rewritten to keep it in the shared strings, as most workbooks do. */
function withSharedStrings(files: Record<string, Uint8Array>): Uint8Array {
  const { DOMParser } = parseHTML("")
  const xml = (source: string) => new DOMParser().parseFromString(source, "text/xml")
  const strings = xml(
    files["xl/sharedStrings.xml"]
      ? strFromU8(files["xl/sharedStrings.xml"])
      : '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
  )
  let count = strings.querySelectorAll("si").length
  for (const path of Object.keys(files).filter((path) => /^xl\/worksheets\/[^/]+\.xml$/.test(path))) {
    const sheet = xml(strFromU8(files[path]))
    for (const cell of sheet.querySelectorAll('c[t="inlineStr"]')) {
      const item = strings.createElement("si")
      const text = strings.createElement("t")
      text.setAttribute("xml:space", "preserve")
      text.textContent = Array.from(cell.querySelectorAll("is t"), (node) => node.textContent).join("")
      item.append(text)
      strings.documentElement.append(item)
      cell.setAttribute("t", "s")
      cell.innerHTML = `<v>${count++}</v>`
    }
    files[path] = strToU8(sheet.toString())
  }
  files["xl/sharedStrings.xml"] = strToU8(strings.toString())
  // A workbook that had no shared strings must now say where they are.
  const relsPath = "xl/_rels/workbook.xml.rels"
  const rels = xml(strFromU8(files[relsPath]))
  if (!Array.from(rels.querySelectorAll("Relationship")).some((node) => node.getAttribute("Type")?.endsWith("/sharedStrings"))) {
    const relationship = rels.createElement("Relationship")
    relationship.setAttribute("Id", "readerSharedStrings")
    relationship.setAttribute("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings")
    relationship.setAttribute("Target", "sharedStrings.xml")
    rels.documentElement.append(relationship)
    files[relsPath] = strToU8(rels.toString())
  }
  return zipSync(files)
}
