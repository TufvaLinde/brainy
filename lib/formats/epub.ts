/**
 * EPUB books, 2 and 3, as one page of HTML for lib/markdown to write down,
 * read as a reading app reads them: each chapter in the order of the book's
 * spine, and those it opens only from a link, as a note, after them; the
 * book's own stylesheets applied as far as Markdown can show them, as a
 * book's italics, headings and lists are as often its classes as its tags;
 * each heading its table of contents leads to set at the level the contents
 * give it, as the reading view lists them, and the printed contents page they
 * stand in for left out; and its links to its chapters and notes kept, each
 * note's mark a superscript the reading view opens the note from. Server-only.
 */
import { createHash } from "node:crypto"
import { parseHTML } from "linkedom"
import type { EmbeddedImage } from "@/lib/db"
import { decode, imageType, ImportError, Pictures, selfContained, unzip } from "@/lib/files"

/** Elements that hold a block of a page, or blocks, as lib/markdown writes them. */
const BLOCK_TAGS = ["address", "article", "aside", "blockquote", "body", "dd", "div", "dl", "dt", "figcaption", "figure", "footer",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody", "td",
  "tfoot", "th", "thead", "tr", "ul"]
const BLOCK = new Set(BLOCK_TAGS)
const BLOCKS = BLOCK_TAGS.join(", ")
const HEADING = /^h([1-6])$/
const HEADINGS = "h1, h2, h3, h4, h5, h6"

/** A place in the book: a file, and an id in it, or "" for where the file starts. */
type Place = { path: string; id: string }
type Item = { id: string; path: string; type: string; properties: string }
/** An entry of the table of contents, at its depth there, 0 for a top-level one. */
type Entry = Place & { label: string; depth: number }

export type Book = { title: string; author: string; excerpt: string | null; html: string; images: EmbeddedImage[]; cover: string | null }

/** The book's chapters in reading order, and what is known of it. One chapter
 *  missing or unreadable is passed over: a damaged book reads as far as it can. */
export function epubToHtml(bytes: Uint8Array): Book {
  const files = unzip(bytes)
  // In the encoding each file declares, as an older book's may be in another than UTF-8.
  const read = (path: string) => (files[path] ? decode(files[path], "") : "")
  const { DOMParser } = parseHTML("")
  const xml = (path: string) => new DOMParser().parseFromString(read(path), "text/xml")
  const html = (path: string) => parseHTML(xhtml(read(path))).document

  const named = elements(xml("META-INF/container.xml"), "rootfile")[0]?.getAttribute("full-path") ?? ""
  // A book that lost its container still has its package document.
  const opf = files[named] ? named : Object.keys(files).find((path) => path.endsWith(".opf"))
  if (!opf) throw new Error("The EPUB has no package document")
  // Only fonts may be obfuscated; anything else encrypted is DRM.
  for (const method of elements(xml("META-INF/encryption.xml"), "EncryptionMethod")) {
    if (!["http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC"].includes(method.getAttribute("Algorithm") ?? "")) {
      throw new ImportError("That EPUB is locked with DRM: only a book without it can be read")
    }
  }
  const book = xml(opf)
  const items: Item[] = elements(book, "item").map((item) => ({
    id: item.getAttribute("id") ?? "",
    path: target(item.getAttribute("href") ?? "", opf)?.path ?? "",
    type: item.getAttribute("media-type") ?? "",
    properties: item.getAttribute("properties") ?? "",
  }))
  const byId = new Map(items.map((item) => [item.id, item]))
  const spine = elements(book, "itemref").flatMap((ref) => {
    const item = byId.get(ref.getAttribute("idref") ?? "")
    return item && files[item.path] ? [{ item, linear: ref.getAttribute("linear") !== "no" }] : []
  })
  // Each file once, where the spine first reads it.
  const reading = [...new Map([...spine.filter((ref) => ref.linear), ...spine.filter((ref) => !ref.linear)]
    .map(({ item }) => [item.path, item])).values()]

  // EPUB 3 lists its contents in a navigation document; EPUB 2, in an NCX.
  const nav = items.find((item) => /\bnav\b/.test(item.properties) && files[item.path])
  const navigation = nav && html(nav.path)
  const navs = Array.from(navigation?.querySelectorAll("nav") ?? [])
  const ncx = byId.get(elements(book, "spine")[0]?.getAttribute("toc") ?? "") ?? items.find((item) => item.type === "application/x-dtbncx+xml")
  const contents = nav && navigation ? navContents(navs.find((element) => typed(element, "toc")) ?? navs[0], nav.path)
    : ncx && files[ncx.path] ? ncxContents(xml(ncx.path), ncx.path) : []
  const printed = new Set([
    nav?.path,
    ...elements(book, "reference").filter((ref) => ref.getAttribute("type") === "toc").map((ref) => target(ref.getAttribute("href") ?? "", opf)?.path),
    ...Array.from(navs.find((element) => typed(element, "landmarks"))?.querySelectorAll("a") ?? [])
      .filter((link) => typed(link, "toc")).map((link) => target(link.getAttribute("href") ?? "", nav!.path)?.path),
  ])

  const pictures = new Pictures()
  const chapters = reading.flatMap((item): { item: Item; picture?: string | null; document?: Document }[] => {
    // A picture in the reading order, as a picture book's pages are, is shown as one.
    const type = imageType(files[item.path])
    if (type) {
      const picture = type === "image/svg+xml" ? selfContained(read(item.path), (src) => files[target(src, item.path)?.path ?? ""]) : files[item.path]
      return [{ item, picture: pictures.address(picture) }]
    }
    const document = html(item.path)
    if (!document.body) return []
    // The printed contents only list what the reading view's contents do, as
    // a page of links; a page the book calls its contents that holds more stays.
    if (printed.has(item.path) && linked(document.body) > 0.7) return []
    return [{ item, document }]
  })
  if (!chapters.length) throw new Error("The EPUB has no chapter that can be read")
  const documents = chapters.flatMap(({ item, document }) => (document ? [{ path: item.path, document, body: document.body }] : []))

  // Where the book's links and contents lead, which alone are marked; and its
  // notes, which their marks are set as superscripts for.
  const targets = new Map<string, Set<string>>()
  const notes = new Set<string>()
  const lead = ({ path, id }: Place) => (targets.get(path) ?? targets.set(path, new Set()).get(path)!).add(id)
  for (const entry of contents) lead(entry)
  for (const { path, body } of documents) {
    for (const link of body.querySelectorAll("a[href]")) {
      const to = target(link.getAttribute("href")!, path)
      if (!to) continue
      lead(to)
      if (typed(link, "noteref")) notes.add(key(to))
    }
    for (const element of body.querySelectorAll("[id]")) {
      if (["footnote", "endnote", "rearnote", "note"].some((type) => typed(element, type))) notes.add(key({ path, id: element.id }))
    }
  }

  const stylesheets = new Map<string, Rule[]>()
  const stylesheet = (path: string, importing: string[] = []): Rule[] => {
    if (importing.includes(path)) return []
    if (!stylesheets.has(path)) {
      stylesheets.set(path, rulesOf(read(path), (href) => {
        const to = target(href, path)
        return to ? stylesheet(to.path, [...importing, path]) : []
      }))
    }
    return stylesheets.get(path)!
  }
  for (const { path, document, body } of documents) {
    const rules = Array.from(document.querySelectorAll("link, style")).flatMap((element) => {
      if (element.localName === "style") return rulesOf(element.textContent!, (href) => stylesheet(target(href, path)?.path ?? ""))
      const href = element.getAttribute("href")
      return href && /\bstylesheet\b/i.test(element.getAttribute("rel") ?? "") ? stylesheet(target(href, path)?.path ?? "") : []
    })
    const ids = targets.get(path) ?? new Set()
    restyle(document, rules, (element) => ids.has(element.id) || Array.from(element.querySelectorAll("[id]")).some((inner) => ids.has(inner.id)))
    restructure(body)
    const bytesAt = (src: string) => files[target(src, path)?.path ?? ""]
    for (const img of body.querySelectorAll("img[alt]")) if (meaningless(img)) img.setAttribute("alt", "")
    pictures.point(body, bytesAt)
    // An SVG in the page, as a cover's often is, is kept as a picture: the reading view draws none.
    for (const svg of body.querySelectorAll("svg")) {
      if (svg.parentElement?.closest("svg")) continue
      svg.setAttribute("xmlns", "http://www.w3.org/2000/svg")
      if (svg.outerHTML.includes("xlink:")) svg.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink")
      const address = pictures.address(selfContained(svg.outerHTML, bytesAt))
      if (!address) continue
      const img = document.createElement("img")
      img.setAttribute("src", address)
      img.setAttribute("alt", svg.querySelector("title")?.textContent ?? "")
      svg.replaceWith(img)
    }
  }

  levelHeadings(contents, new Map(documents.map(({ path, body }) => [path, body])))

  // A place's anchor, or the one already where it is; a picture's page has its own.
  const anchors = new Map<string, string>()
  for (const { item, picture } of chapters) if (picture) anchors.set(key({ path: item.path, id: "" }), anchorOf({ path: item.path, id: "" }))
  for (const { path, body } of documents) {
    const ids = targets.get(path)
    if (!ids) continue
    for (const element of body.querySelectorAll("[id]")) {
      if (ids.has(element.id) && !element.closest("svg")) anchors.set(key({ path, id: element.id }), mark(element, anchorOf({ path, id: element.id })))
    }
    anchors.set(key({ path, id: "" }), mark(body, anchorOf({ path, id: "" })))
  }
  for (const { path, body } of documents) {
    for (const link of body.querySelectorAll("a[href]")) {
      const to = target(link.getAttribute("href")!, path)
      if (!to) continue
      // To the file, if the place in it is gone, as a hidden one is.
      const anchor = anchors.get(key(to)) ?? anchors.get(key({ path: to.path, id: "" }))
      if (!anchor) {
        link.removeAttribute("href")
        continue
      }
      link.setAttribute("href", `#${anchor}`)
      if (notes.has(key(to)) || isMark(link)) superscript(link)
    }
  }

  // Each chapter a block of its own, as the next begins a new page.
  const sections = chapters.map(({ item, picture, document }) => document ? `<section>${document.body.innerHTML}</section>`
    : picture ? `<section><p><a id="${anchorOf({ path: item.path, id: "" })}"></a><img src="${picture}" alt=""></p></section>` : "")

  const metadata = elements(book, "metadata")[0] ?? book
  const refined = (element: Element, property: string) =>
    elements(metadata, "meta").find((meta) => meta.getAttribute("refines") === `#${element.getAttribute("id")}` && meta.getAttribute("property") === property)
      ?.textContent!.trim()
  const titles = elements(metadata, "title").filter((title) => title.textContent!.trim())
  const title = titles.find((element) => refined(element, "title-type") === "main") ?? titles[0]
  // Its authors, not its editors, translators or illustrators, unless it names no author.
  const creators = elements(metadata, "creator").filter((creator) => creator.textContent!.trim())
  const role = (creator: Element) => creator.getAttribute("opf:role") ?? refined(creator, "role") ?? "aut"
  const authors = creators.some((creator) => role(creator) === "aut") ? creators.filter((creator) => role(creator) === "aut") : creators
  // A description is often HTML, escaped within the package's XML.
  const description = elements(metadata, "description")[0]?.textContent
  const excerpt = description ? parseHTML(`<body>${description}</body>`).document.body.textContent!.replace(/\s+/g, " ").trim() : ""
  // EPUB 3 marks its cover; EPUB 2 names it in a <meta>, by its id or, at times, its file.
  const coverName = elements(metadata, "meta").find((meta) => meta.getAttribute("name") === "cover")?.getAttribute("content")
  const coverItem = items.find((item) => /\bcover-image\b/.test(item.properties))
    ?? (coverName ? byId.get(coverName) ?? items.find((item) => item.path === target(coverName, opf)?.path) : undefined)
  // Kept before the pictures are listed, so it is one of them.
  const cover = coverItem ? pictures.address(files[coverItem.path]) : null

  return {
    title: title?.textContent!.trim() ?? "",
    author: authors.map((creator) => creator.textContent!.trim()).join(", "),
    excerpt: excerpt || null,
    // A soft hyphen breaks a word for a narrow page, and would part it in search and highlights.
    html: sections.join("\n").replaceAll("­", ""),
    images: pictures.images,
    cover,
  }
}

/** Elements by local name, as an EPUB may or may not prefix its namespaces. */
const elements = (root: Document | Element, name: string) =>
  Array.from(root.querySelectorAll("*")).filter((element) => element.localName.split(":").pop() === name)

/** Whether an element is of an EPUB 3 structural type, or its ARIA role. */
const typed = (element: Element, type: string) =>
  new RegExp(`(?:^|\\s)${type}(?:\\s|$)`).test(element.getAttribute("epub:type") ?? "") || element.getAttribute("role") === `doc-${type}`

const decoded = (text: string) => {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** Where an href leads in the book: it is relative to the file it is in, and percent-encoded. */
function target(href: string, from: string): Place | null {
  const url = URL.parse(href, `file:///${from}`)
  return url?.protocol === "file:" ? { path: decoded(url.pathname.slice(1)), id: decoded(url.hash.slice(1)) } : null
}

const key = ({ path, id }: Place) => `${path}#${id}`
const anchorOf = (place: Place) => `reader-${createHash("sha256").update(key(place)).digest("hex").slice(0, 20)}`

/** XHTML as an HTML parser reads it: there, an element closed in its own
 *  tag, as a page's mark <a id="p5"/> is, would hold all that follows it. */
const VOID = /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i
const xhtml = (text: string) =>
  text.replace(/<([a-zA-Z][\w:.-]*)(\s[^<>]*?)?\s*\/>/g, (tag, name: string, attributes = "") => (VOID.test(name) ? tag : `<${name}${attributes}></${name}>`))

/** Text compared as its letters and digits alone, as markup and labels space and punctuate it anyhow. */
const letters = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")

/** How much of a page's text is in its links. */
function linked(body: Element): number {
  const text = letters(body.textContent!).length
  return text ? Array.from(body.querySelectorAll("a[href]")).reduce((sum, link) => sum + letters(link.textContent!).length, 0) / text : 0
}

/** The entries of EPUB 3's table of contents, a list of lists, each entry a
 *  link or, heading those under it, a label. */
function navContents(nav: Element | undefined, path: string): Entry[] {
  const list = (ol: Element | undefined, depth: number): Entry[] =>
    Array.from(ol?.children ?? []).filter((li) => li.localName === "li").flatMap((li) => {
      const children = Array.from(li.children)
      const link = children.find((child) => child.localName === "a")
      const to = link && target(link.getAttribute("href") ?? "", path)
      const label = (link ?? children.find((child) => child.localName === "span"))?.textContent!.replace(/\s+/g, " ").trim() ?? ""
      return [...(to ? [{ ...to, label, depth }] : []), ...list(children.find((child) => child.localName === "ol"), depth + 1)]
    })
  return list(Array.from(nav?.children ?? []).find((child) => child.localName === "ol"), 0)
}

/** The entries of EPUB 2's table of contents, nested navPoints, each labeled
 *  and leading to its content before any under it. */
function ncxContents(ncx: Document, path: string): Entry[] {
  return elements(ncx, "navPoint").flatMap((point) => {
    const to = target(elements(point, "content")[0]?.getAttribute("src") ?? "", path)
    let depth = 0
    for (let parent = point.parentElement; parent; parent = parent.parentElement) if (parent.localName.split(":").pop() === "navPoint") depth++
    return to ? [{ ...to, label: elements(point, "text")[0]?.textContent!.replace(/\s+/g, " ").trim() ?? "", depth }] : []
  })
}

/** What of a book's styles Markdown can show, as a rule declares it: its
 *  emphasis, its superscripts, whether it is a block, shown at all, and how
 *  large, relative to what holds it, or not. */
type Style = { italic?: boolean; bold?: boolean; shift?: string; display?: string; size?: { relative: boolean; value: number } }
type Rule = { selectors: string[]; style: Style; important: Style }

/** A stylesheet's rules in order, those it imports where it imports them, as a
 *  reading app on a screen applies them: none for print, or for screens of
 *  some size only, which a reader's may not be. */
function rulesOf(css: string, imported: (href: string) => Rule[]): Rule[] {
  const forScreens = (media: string) => !media.includes("(") && (!media.trim() || /\b(?:all|screen)\b/i.test(media))
  return statements(css.replace(/\/\*[\s\S]*?\*\//g, "")).flatMap(({ prelude, block }): Rule[] => {
    const at = /^@([\w-]+)\s*([\s\S]*)$/.exec(prelude)
    if (!at) return block === null ? [] : [{ selectors: prelude.split(","), ...declarations(block) }]
    const [, name, rest] = at
    if (name === "import") {
      const [, href, media] = /^(?:url\(\s*)?["']?([^"')\s]+)["']?\s*\)?\s*(.*)$/.exec(rest) ?? []
      return href && forScreens(media) ? imported(href) : []
    }
    return block !== null && (name === "supports" || (name === "media" && forScreens(rest))) ? rulesOf(block, imported) : []
  })
}

/** A stylesheet's statements: a rule or an at-rule's prelude, and its block, if it has one. */
function statements(css: string): { prelude: string; block: string | null }[] {
  const found: { prelude: string; block: string | null }[] = []
  let [start, depth, open] = [0, 0, 0]
  for (let at = 0; at < css.length; at++) {
    const character = css[at]
    if (character === '"' || character === "'") {
      at = css.indexOf(character, at + 1)
      if (at < 0) break
    } else if (character === "{" && depth++ === 0) open = at
    else if (character === "}" && depth > 0 && --depth === 0) {
      found.push({ prelude: css.slice(start, open).trim(), block: css.slice(open + 1, at) })
      start = at + 1
    } else if (character === ";" && depth === 0) {
      found.push({ prelude: css.slice(start, at).trim(), block: null })
      start = at + 1
    }
  }
  return found
}

/** A block's declarations of what Style keeps, those marked !important apart. */
function declarations(block: string): { style: Style; important: Style } {
  const style: Style = {}
  const important: Style = {}
  for (const declaration of block.split(";")) {
    const colon = declaration.indexOf(":")
    if (colon < 0) continue
    const property = declaration.slice(0, colon).trim().toLowerCase()
    const value = declaration.slice(colon + 1).trim().toLowerCase()
    const marked = /!\s*important$/.test(value)
    Object.assign(marked ? important : style, declared(property, value.replace(/!\s*important$/, "").trim()))
  }
  return { style, important }
}

const SIZES: Record<string, number> = { "xx-small": 0.6, "x-small": 0.75, small: 0.89, medium: 1, large: 1.2, "x-large": 1.5, "xx-large": 2 }

function declared(property: string, value: string): Style {
  const size = (value: string): Style["size"] => {
    const [, number, unit] = /^(\d*\.?\d+)(%|em|rem|px|pt)$/.exec(value) ?? []
    if (number) {
      const n = Number(number)
      return unit === "%" ? { relative: true, value: n / 100 } : unit === "em" ? { relative: true, value: n }
        : { relative: false, value: unit === "px" ? n / 16 : unit === "pt" ? n / 12 : n }
    }
    if (value in SIZES) return { relative: false, value: SIZES[value] }
    return value === "larger" ? { relative: true, value: 1.2 } : value === "smaller" ? { relative: true, value: 0.83 } : undefined
  }
  switch (property) {
    case "font-style":
      return /^(?:italic|oblique)/.test(value) ? { italic: true } : value === "normal" ? { italic: false } : {}
    case "font-weight":
      return /^(?:bold|bolder|[6-9]00)$/.test(value) ? { bold: true } : /^(?:normal|lighter|[1-5]00)$/.test(value) ? { bold: false } : {}
    case "vertical-align":
      return /^(?:super|sub|baseline)$/.test(value) ? { shift: value } : {}
    case "display":
      return /^(?:none|block|inline|inline-block|list-item|table|flex|grid)$/.test(value) ? { display: value } : {}
    case "font-size": {
      const found = size(value)
      return found ? { size: found } : {}
    }
    case "font": {
      // The shorthand, if it is one: its size before the line height or the family.
      const found = size(/(?:^|\s)(\d*\.?\d+(?:%|r?em|px|pt)|(?:xx?-)?(?:small|large)|medium)(?=\/|\s)/.exec(`${value} `)?.[1] ?? "")
      return found ? { italic: /\b(?:italic|oblique)\b/.test(value), bold: /\b(?:bold|bolder|[6-9]00)\b/.test(value), size: found } : {}
    }
  }
  return {}
}

/** Selectors that match only as the reader acts, or name parts of elements, which a page as it is read has none of. */
const DYNAMIC = /::|\||:(?:hover|focus|focus-within|focus-visible|active|visited|link|target|checked|before|after|first-letter|first-line|selection|lang)\b/

/** A selector's specificity as one number: its ids, its classes, attributes
 *  and pseudo-classes, then its types, each well under a hundred. */
function specificity(selector: string): number {
  const plain = selector.replace(/:(?:not|is)\(/g, " (")
  const ids = plain.match(/#[\w-]+/g)?.length ?? 0
  const classes = plain.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g)?.length ?? 0
  const types = plain.replace(/\[[^\]]*\]|[#.:][\w-]+/g, " ").match(/[a-z][\w-]*/gi)?.length ?? 0
  return ids * 10_000 + classes * 100 + types
}

/** Each element's style by the cascade: what is important first, then what is
 *  more specific, then what comes later; an element's own style above any
 *  rule. A rule naming a class the page has none of is passed over unmatched,
 *  as most of a publisher's stylesheet is. */
function cascade(document: Document, rules: Rule[]): Map<Element, Style> {
  const classes = new Set(Array.from(document.querySelectorAll("[class]")).flatMap((element) => Array.from(element.classList)))
  type Declared = { rank: [number, number, number]; style: Style; selector?: string; element?: Element }
  const found: Declared[] = []
  rules.forEach(({ selectors, style, important }, order) => {
    for (const selector of selectors.map((s) => s.trim())) {
      if (!selector || DYNAMIC.test(selector)) continue
      if (selector.replace(/:not\([^)]*\)/g, "").match(/\.[\w-]+/g)?.some((name) => !classes.has(name.slice(1)))) continue
      const rank = specificity(selector)
      if (Object.keys(style).length) found.push({ rank: [0, rank, order], style, selector })
      if (Object.keys(important).length) found.push({ rank: [1, rank, order], style: important, selector })
    }
  })
  for (const element of document.querySelectorAll("[style]")) {
    const { style, important } = declarations(element.getAttribute("style")!)
    found.push({ rank: [0, 1e9, 0], style, element }, { rank: [1, 1e9, 0], style: important, element })
  }
  found.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2])
  const styles = new Map<Element, Style>()
  for (const { style, selector, element } of found) {
    let matched: Iterable<Element>
    try {
      matched = element ? [element] : document.querySelectorAll(selector!)
    } catch {
      continue // One the parser can't read, as a namespaced attribute's is.
    }
    for (const match of matched) styles.set(match, { ...styles.get(match), ...style })
  }
  return styles
}

/** An element as another, its attributes and contents moved to it. */
function renamed(element: Element, name: string): Element {
  const replacement = element.ownerDocument.createElement(name)
  for (const { name, value } of Array.from(element.attributes)) replacement.setAttribute(name, value)
  replacement.append(...element.childNodes)
  element.replaceWith(replacement)
  return replacement
}

const ITALIC = /^(?:em|i|cite|var|dfn|address)$/
const BOLD = /^(?:b|strong|th)$/

/** A chapter as its styles show it, in what Markdown can write: what is
 *  hidden left out, unless a link leads into it, as a note shown in a popup
 *  is hidden in its page; what is shown as a block or in a line, as one; a
 *  short block set larger than what holds it, a heading; and what is shown
 *  italic, bold or raised, emphasis or superscript. Emphasis is marked where
 *  it starts, around a run of words, never around blocks, which can't be in
 *  Markdown; a heading shows its own style, so only words set apart in it are marked. */
function restyle(document: Document, rules: Rule[], holdsTarget: (element: Element) => boolean): void {
  const body = document.body
  const styles = cascade(document, rules)
  const styleOf = (element: Element) => styles.get(element) ?? {}
  const moved = (element: Element, name: string) => {
    const replacement = renamed(element, name)
    styles.set(replacement, styleOf(element))
    return replacement
  }
  for (const element of body.querySelectorAll("*")) {
    const { display } = styleOf(element)
    if (!display || element.closest("svg, math")) continue
    if (display === "none") {
      if (!holdsTarget(element)) element.remove()
    } else if (element.localName === "span" && /^(?:block|list-item|table|flex|grid)$/.test(display)) moved(element, "div")
    else if (/^(?:div|p)$/.test(element.localName) && /^inline/.test(display) && !element.querySelector(BLOCKS)) moved(element, "span")
  }

  type Computed = { italic: boolean; bold: boolean; size: number }
  const computed = new Map<Element, Computed>()
  const compute = (element: Element, parent: Computed) => {
    const own = styleOf(element)
    const tag = element.localName
    const style = {
      italic: own.italic ?? (ITALIC.test(tag) || parent.italic),
      bold: own.bold ?? (BOLD.test(tag) || HEADING.test(tag) || parent.bold),
      size: own.size ? (own.size.relative ? parent.size * own.size.value : own.size.value) : parent.size,
    }
    computed.set(element, style)
    for (const child of element.children) compute(child, style)
  }
  compute(body, { italic: false, bold: false, size: 1 })
  const base = computed.get(body)!.size

  for (const element of body.querySelectorAll("div, p")) {
    const { size } = computed.get(element)!
    const parent = computed.get(element.parentElement!)?.size ?? base
    const text = element.textContent!.trim()
    if (size < base * 1.2 || size < parent * 1.2 || !text || text.length > 120) continue
    // A byline's mark or a picture is no heading's.
    if (element.querySelector(`${BLOCKS}, sup, sub, img`) || element.closest(`li, td, th, figure, blockquote, aside, ${HEADINGS}`)) continue
    computed.set(moved(element, size >= base * 1.45 ? "h2" : "h3"), { ...computed.get(element)!, bold: true })
  }

  const unwrapped: Element[] = []
  type Shown = { italic: boolean; bold: boolean; raised: boolean }
  const emphasize = (element: Element, shown: Shown) => {
    const style = computed.get(element)
    if (!style || element.localName === "svg" || element.localName === "math") return
    const tag = element.localName
    const plain = !!element.textContent!.trim() && !element.querySelector(BLOCKS)
    const marks: string[] = []
    const next = { ...shown }
    if (HEADING.test(tag)) Object.assign(next, { italic: style.italic, bold: style.bold })
    else {
      for (const [flag, tags, name] of [["italic", /^(?:em|i)$/, "em"], ["bold", /^(?:b|strong)$/, "strong"]] as const) {
        if (tags.test(tag)) {
          // Emphasis in emphasis, or styled away, shows nothing Markdown can.
          if (!style[flag] || shown[flag]) unwrapped.push(element)
          else next[flag] = true
        } else if (style[flag] && !shown[flag] && plain) {
          marks.push(name)
          next[flag] = true
        }
      }
      const shift = styleOf(element).shift
      if (/^(?:sup|sub)$/.test(tag)) next.raised = true
      else if ((shift === "super" || shift === "sub") && !shown.raised && plain) {
        marks.push(shift === "super" ? "sup" : "sub")
        next.raised = true
      }
    }
    for (const child of Array.from(element.children)) emphasize(child, next)
    for (const name of marks) {
      const wrapper = document.createElement(name)
      wrapper.append(...element.childNodes)
      element.append(wrapper)
    }
  }
  emphasize(body, { italic: false, bold: false, raised: false })
  for (const element of unwrapped) element.replaceWith(...element.childNodes)
}

/** Blocks that only hold others, as a note holds its paragraphs; a run of
 *  words before the first, as a note's number, is a line of its own in them. */
const WRAPS = "div, section, article, aside, blockquote, li, dd, figure"
const WRAPPER = /^(?:div|section|article|aside|blockquote|figure)$/

/** A list's marker, a number or a bullet: what a list set out as blocks begins each item with. */
const MARKER = /^\(?(?:(\d{1,3})|[•·▪■□◦○●‣–—-])[.)]?$/

/** Whether an element's first child element is the first thing in it, no words before. */
function leads(element: Element): Element | null {
  const first = element.firstElementChild
  if (!first) return null
  for (const node of element.childNodes) {
    if (node === first) return first
    if (node.textContent!.trim()) return null
  }
  return null
}

/** What a book sets out as blocks, as Markdown would have it: a list whose
 *  items are blocks that each begin with their marker, as a list; a marker or
 *  note's number on its own before blocks, at the start of the first; a
 *  paragraph a page broke, whole; and an epigraph or motto, a quote. */
function restructure(body: Element): void {
  const document = body.ownerDocument
  // Each run of blocks led by markers, numbered in order or all bullets, as a
  // notes section's notes are under its heading: one numbered alone is a list
  // too, as Markdown would write it as one.
  const markerOf = (item: Element) => /^(?:div|p|li|section|aside|dd)$/.test(item.localName) ? MARKER.exec(leads(item)?.textContent!.trim() ?? "") : null
  for (const holder of Array.from(body.querySelectorAll("body, div, section, blockquote, aside"))) {
    if (Array.from(holder.childNodes).some((node) => node.nodeType === 3 && node.textContent!.trim())) continue
    const runs: Element[][] = []
    let last: number | null | undefined
    for (const child of Array.from(holder.children)) {
      const marker = markerOf(child)
      const number = marker && (marker[1] ? Number(marker[1]) : null)
      const run = runs.at(-1)
      if (!marker) last = undefined
      else if (run && last !== undefined && (number === null ? last === null : last !== null && number === last + 1)) run.push(child)
      else runs.push([child])
      if (marker) last = number
    }
    for (const run of runs) {
      const start = Number(markerOf(run[0])![1] ?? NaN)
      if (Number.isNaN(start) && run.length < 2) continue
      const list = document.createElement(Number.isNaN(start) ? "ul" : "ol")
      if (start > 1) list.setAttribute("start", String(start))
      run[0].before(list)
      for (const item of run) {
        leads(item)!.remove()
        const li = document.createElement("li")
        if (item.id) li.id = item.id
        li.append(...item.childNodes)
        for (const end of [li.firstChild, li.lastChild]) if (end?.nodeType === 3 && !end.textContent!.trim()) end.remove()
        list.append(li)
        item.remove()
      }
    }
  }

  for (const element of Array.from(body.querySelectorAll(WRAPS))) {
    const nodes = Array.from(element.childNodes)
    const first = nodes.findIndex((node) => node.nodeType === 1 && BLOCK.has((node as Element).localName))
    const before = nodes.slice(0, Math.max(first, 0))
    const words = before.map((node) => node.textContent).join("").trim()
    if (!words || words.length > 12 || before.some((node) => node.nodeType === 1 && (node as Element).querySelector("img"))) continue
    let into = nodes[first] as Element
    for (let inner = leads(into); WRAPPER.test(into.localName) && inner && /^(?:p|dd)$|^(?:div|section|article|aside|blockquote|figure)$/.test(inner.localName); inner = leads(into)) into = inner
    if (/^(?:p|div|dd|blockquote)$/.test(into.localName)) into.prepend(...before, " ")
  }

  // A paragraph a printed page broke, as a book made from print may keep it:
  // its second part led by the page's mark, its first ending mid-sentence.
  for (const element of Array.from(body.querySelectorAll("p, div"))) {
    const marker = leads(element)
    const previous = element.previousElementSibling
    if (!marker || !previous || previous.localName !== element.localName || previous.className !== element.className) continue
    if (!typed(marker, "pagebreak") && !(marker.id && !marker.textContent!.trim() && !marker.children.length)) continue
    if (!/[\p{L},\-–—]$/u.test(previous.textContent!.trim()) || element.querySelector(BLOCKS) || previous.querySelector(BLOCKS)) continue
    previous.append(" ", ...element.childNodes)
    element.remove()
  }

  for (const element of Array.from(body.querySelectorAll("div, p, section, aside"))) {
    if (typed(element, "epigraph") || /epigraph|motto/i.test(element.getAttribute("class") ?? "")) renamed(element, "blockquote")
  }
}

/** An alt that is only the word for a picture, or its file's name, says nothing. */
function meaningless(img: Element): boolean {
  const alt = img.getAttribute("alt")!.trim()
  const file = /([^/]+?)(?:\.\w+)?$/.exec(img.getAttribute("src") ?? "")?.[1] ?? ""
  return /^(?:image|img|picture|figure|graphic|photo|cover)\s*\d*$/i.test(alt) || decoded(alt) === decoded(file)
}

/** Each heading the table of contents leads to, at the level its depth gives
 *  it, the reading view's contents listing them as the book does; a block it
 *  leads to that only names what it leads to, as a title set as a paragraph
 *  does, made one. Each chapter's other headings move as its first did, so
 *  they stay under it. */
function levelHeadings(contents: Entry[], bodies: Map<string, Element>): void {
  const levels = new Map<Element, number>()
  const shifts = new Map<Element, number>()
  for (const entry of contents) {
    const body = bodies.get(entry.path)
    let element = entry.id ? body?.ownerDocument.getElementById(entry.id) : body
    if (!body || !element || !body.contains(element)) continue
    let heading = element.closest(HEADINGS)
    // An empty mark just before what it leads to, as a chapter's often is.
    if (!heading && !element.textContent!.trim()) element = element.nextElementSibling ?? element
    for (let first = leads(element); !heading && !HEADING.test(element.localName) && first && BLOCK.has(first.localName); first = leads(element)) {
      element = first
    }
    heading ??= HEADING.test(element.localName) ? element : null
    // A title set as a paragraph, which the contents name.
    const named = letters(element.textContent!)
    const label = letters(entry.label)
    if (!heading && /^(?:div|p)$/.test(element.localName) && !element.querySelector(BLOCKS) && named && label
      && (named.includes(label) || label.includes(named)) && named.length <= label.length * 2) heading = element
    if (!heading || levels.has(heading)) continue
    const level = Math.min(entry.depth + 1, 6)
    const was = HEADING.exec(heading.localName)?.[1]
    if (!shifts.has(body) && was) shifts.set(body, level - Number(was))
    levels.set(heading, level)
  }
  const leveled = new Set<Element>()
  for (const [heading, level] of levels) if (heading.localName !== `h${level}`) leveled.add(renamed(heading, `h${level}`))
  for (const body of bodies.values()) {
    const shift = shifts.get(body) ?? 0
    for (const heading of Array.from(body.querySelectorAll(HEADINGS))) {
      const was = Number(heading.localName[1])
      const level = Math.min(Math.max(was + shift, 1), 6)
      if (!levels.has(heading) && !leveled.has(heading) && level !== was) renamed(heading, `h${level}`)
    }
  }
}

/** A place a link leads to, marked by an anchor: within the first block of
 *  the element there, before its words, as an anchor of its own would be an
 *  empty line in the page. Where an anchor is already, it is that place's too. */
function mark(element: Element, id: string): string {
  // The anchor a step from a node, past any space.
  const anchorBy = (node: Node | null, step: "previousSibling" | "nextSibling") => {
    while (node?.nodeType === 3 && !node.textContent!.trim()) node = node[step]
    const anchor = node as Element | null
    return anchor?.nodeType === 1 && anchor.localName === "a" && /^reader-/.test(anchor.id) ? anchor.id : null
  }
  const place = element.ownerDocument.createElement("a")
  place.id = id
  if (!BLOCK.has(element.localName)) {
    const found = anchorBy(element.previousSibling, "previousSibling")
    if (!found) element.before(place)
    return found ?? id
  }
  let block = element
  for (let first = leads(block); first && BLOCK.has(first.localName); first = leads(block)) block = first
  const found = anchorBy(block.firstChild, "nextSibling")
  if (!found) block.prepend(place)
  return found ?? id
}

/** A link that is a note's mark: a number or a sign alone, raised. */
const isMark = (link: Element) =>
  /^[[(]?(?:\d{1,3}|[a-z]|[*†‡§¶#]+)[\])]?$/i.test(link.textContent!.trim()) && !!(link.closest("sup") ?? link.querySelector("sup"))

/** A note's mark as a superscript within its link, the one way Markdown keeps
 *  both: the reading view opens the note from it (see components/notes). */
function superscript(link: Element): void {
  const sup = link.closest("sup")
  const raised = link.ownerDocument.createElement("sup")
  if (sup && letters(sup.textContent!) === letters(link.textContent!)) {
    raised.textContent = sup.textContent!.trim()
    link.replaceChildren(raised)
    sup.replaceWith(link)
  } else if (!link.querySelector("sup") && !sup) {
    raised.append(...link.childNodes)
    link.append(raised)
  }
}
