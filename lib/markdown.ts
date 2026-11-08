/**
 * Markdown, the one form an article is kept in. Whatever it came from, it is
 * written down as headings, paragraphs, lists, quotes, code, tables, images,
 * links, footnotes and maths, and nothing else; so every article reads alike,
 * and nothing of the source's own, no script, style or layout, ever reaches
 * the reading view. Server-only.
 */

import { parseHTML } from "linkedom"
import { footnote } from "@mdit/plugin-footnote"
import { tex } from "@mdit/plugin-tex"
import MarkdownIt from "markdown-it"
import temml from "temml"
import TurndownService from "turndown"

/** Elements that begin a block of their own, which a line break before them can't add to. */
const OWN_BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DIV|DL|FIGURE|H[1-6]|HR|OL|P|PRE|SECTION|TABLE|UL)$/

/** The id of a place in a book that its own links lead to (see lib/formats/epub),
 *  kept in the Markdown as an empty anchor. */
const ANCHOR = /^reader-[a-f0-9]{20}$/

const bodyOf = (html: string) => parseHTML(`<!doctype html><html><body>${html}</body></html>`).document.body

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
  hr: "---",
  // A backslash, not two trailing spaces, which the trimming of lines would take.
  br: "\\",
})

/** Stands in for a "!" just before a link, which as it is would make the
 *  link a picture: a noncharacter, which no text holds. */
const BANG_BEFORE_LINK = "\uFDD0"

// Turndown leaves "<" be, and an article about HTML would turn into HTML; and
// "$", which would turn prices into maths. Only the maths rule writes a bare "$".
const escapeMarkdown = turndown.escape.bind(turndown)
turndown.escape = (text) => escapeMarkdown(text).replace(/[<$]/g, "\\$&").replaceAll(BANG_BEFORE_LINK, "\\!")

// A marker followed by one space, its item's lines indented to match: what
// lists look like written by hand, and how CommonMark nests them.
turndown.addRule("listItem", {
  filter: "li",
  replacement(content, node) {
    const list = node.parentNode as HTMLElement
    const start = Number(list.getAttribute("start") ?? 1)
    const marker = list.nodeName === "OL" ? `${start + Array.from(list.children).indexOf(node as HTMLElement)}. ` : "- "
    const paragraphs = /\n$/.test(content)
    const body = content.replace(/^\n+|\n+$/g, "") + (paragraphs ? "\n" : "")
    return marker + body.replace(/\n/g, `\n${" ".repeat(marker.length)}`) + (node.nextSibling ? "\n" : "")
  },
})

// Any preformatted text is code, with or without a <code> inside, fenced with
// more backticks than it holds, so none of its own end it.
turndown.addRule("code", {
  filter: "pre",
  replacement(_, node) {
    const element = node as HTMLElement
    const tagged = element.querySelector("[data-lang], [class*=language-]") ?? element
    const language =
      tagged.getAttribute("data-lang") ?? /language-([\w+#-]+)/.exec(tagged.getAttribute("class") ?? "")?.[1] ?? ""
    const code = element.textContent!.replace(/\n$/, "")
    const fence = "`".repeat(Math.max(3, ...(code.match(/`+/g) ?? []).map((run) => run.length + 1)))
    return `\n\n${fence}${language}\n${code}\n${fence}\n\n`
  },
})

// Footnotes as Defuddle standardizes them: a reference, <sup><a href="#fn:1">,
// and the notes, a list of <li id="fn:1"> with links back. Turndown tries the
// rule added last first, so a note's <li> is this rule's, not listItem's.
turndown.addRule("footnoteReference", {
  filter: (node) => node.nodeName === "SUP" && !!node.querySelector('a[href^="#fn:"]'),
  replacement: (_, node) => `[^${(node as HTMLElement).querySelector("a")!.getAttribute("href")!.slice(4)}]`,
})
turndown.addRule("footnote", {
  filter: (node) => node.nodeName === "LI" && /^fn:/.test(node.getAttribute("id") ?? ""),
  replacement: (content, node) =>
    `\n\n[^${(node as HTMLElement).id.slice(3)}]: ${content.trim().replace(/\n/g, "\n    ")}\n\n`,
})
turndown.addRule("footnotes", {
  filter: (node) => node.nodeName === "OL" && !!node.querySelector('li[id^="fn:"]'),
  replacement: (content) => content,
})

// A link leads to the web, to an email address or to a place in a book; one
// to a place within the page leads nowhere once the page is gone, and one to
// a script mustn't lead anywhere, so only their words are kept. A link back to
// a footnote's mark, or with nothing to click, is dropped.
turndown.addRule("link", {
  filter: (node) =>
    node.nodeName === "A" &&
    (!/^(https?:|mailto:|#reader-)/i.test(node.getAttribute("href") ?? "") ||
      (!node.textContent!.trim() && !node.querySelector("img"))),
  replacement: (content, node) => (/^#fnref:/.test((node as HTMLElement).getAttribute("href")!) ? "" : content),
})

/** A table's rows of cells, if it is a table of two columns or more; one that
 *  only lays a page out, a single column or tables in tables, is none. */
function grid(table: Element | null): Element[][] | null {
  if (!table || table.querySelector("table")) return null
  const cells = Array.from(table.querySelectorAll("tr"), (row) =>
    Array.from(row.children).filter((cell) => /^T[DH]$/.test(cell.nodeName)),
  )
  return cells.some((row) => row.length >= 2) ? cells : null
}

// A table becomes a Markdown one, its first row the header and each cell
// flattened to a line; one that only lays a page out is read through.
turndown.addRule("table", {
  filter: "table",
  replacement(content, node) {
    const cells = grid(node as Element)
    if (!cells) return `\n\n${content}\n\n`
    const width = Math.max(...cells.map((row) => row.length))
    const line = (row: Element[]) =>
      `| ${[...row, ...Array(width - row.length).fill(null)]
        .map((cell) => (cell ? turndown.turndown(cell.innerHTML).replace(/\n+/g, " ").replace(/\|/g, "\\|") : ""))
        .join(" | ")} |`
    const [head, ...body] = cells
    return `\n\n${[line(head), `|${" --- |".repeat(width)}`, ...body.map(line)].join("\n")}\n\n`
  },
})

// Maths as Defuddle standardizes it, <math> with its LaTeX in data-latex, is
// written as LaTeX between dollars, the reading view's to draw.
turndown.addRule("math", {
  filter: (node) => node.nodeName.toLowerCase() === "math",
  replacement(_, node) {
    const math = node as HTMLElement
    const latex = (math.getAttribute("data-latex") ?? math.textContent!).trim()
    return math.getAttribute("display") === "block" ? `\n\n$$\n${latex}\n$$\n\n` : `$${latex}$`
  },
})

// A caption in italics, set apart from the paragraphs around it.
turndown.addRule("caption", {
  filter: "figcaption",
  replacement(content) {
    const caption = content.trim()
    return caption && !caption.includes("\n") ? `\n\n_${caption}_\n\n` : content
  },
})

// Something to watch or hear is a link to it: the reading view plays nothing.
turndown.addRule("media", {
  filter: ["iframe", "video", "audio", "embed", "object"],
  replacement(_, node) {
    const element = node as HTMLElement
    const src = element.getAttribute("src") ?? element.querySelector("source")?.getAttribute("src")
    const youtube = /youtube(?:-nocookie)?\.com\/embed\/([\w-]+)/.exec(src ?? "")?.[1]
    const href = youtube ? `https://www.youtube.com/watch?v=${youtube}` : src
    if (!href || !/^https?:/.test(href)) return ""
    return `\n\n[${element.getAttribute("title") || (node.nodeName === "AUDIO" ? "Listen" : "Watch")}](${href})\n\n`
  },
})

/** Wide enough for the widest column on a screen of twice the density. */
const SHARP = 1400

/** Of the sizes an image comes in, the smallest that is sharp, or else the
 *  largest. Its URLs may hold commas, so it is read token by token. */
function sharpest(srcset: string): string | undefined {
  const sizes: { url: string; width: number }[] = []
  for (const token of srcset.trim().split(/\s+/)) {
    const descriptor = /^(\d+(?:\.\d+)?)([wx]),?$/.exec(token)
    if (!descriptor) sizes.push({ url: token.replace(/,$/, ""), width: 0 })
    else if (descriptor[2] === "w" && sizes.length) sizes[sizes.length - 1].width = Number(descriptor[1])
  }
  const sized = sizes.filter((size) => size.width && /^https?:/.test(size.url)).sort((a, b) => a.width - b.width)
  return (sized.find((size) => size.width >= SHARP) ?? sized.at(-1))?.url
}

// An image is one the page has loaded, not a placeholder for one it would, or
// one kept with the article, such as an EPUB's (see lib/formats/epub).
turndown.addRule("image", {
  filter: "img",
  replacement(_, node) {
    const image = node as HTMLImageElement
    const src = sharpest(image.getAttribute("srcset") ?? "") ?? image.getAttribute("src") ?? ""
    const alt = (image.getAttribute("alt") ?? "").replace(/[\[\]\\]/g, "\\$&").replace(/\s+/g, " ")
    return /^(https?:|\/images\/)/.test(src) ? `![${alt}](${src.replace(/[()\s]/g, encodeURIComponent)})` : ""
  },
})

// What Markdown has no way to write is kept as HTML, the only HTML render lets
// through: a superscript, a subscript, and a book's anchor. Added after the
// link rule, so tried before it, which would take the anchor for a link.
turndown.keep(["sup", "sub"])
turndown.addRule("anchor", {
  filter: (node) => node.nodeName === "A" && ANCHOR.test(node.getAttribute("id") ?? ""),
  replacement: (_, node) => `<a id="${(node as HTMLElement).id}"></a>`,
})

/** An article's HTML, Defuddle's, written down as Markdown; its title is the
 *  reading view's to show, so a heading repeating it is dropped. */
export function toMarkdown(html: string, title: string): string {
  const body = bodyOf(html)
  // Removed first, so a block of controls alone is seen to hold no words.
  for (const element of body.querySelectorAll("script, style, noscript, template, button, svg, canvas")) element.remove()
  // Text compared as its letters alone, as markup puts spaces anywhere.
  const letters = (text: string | null) => text!.replace(/\s+/g, "")
  // A book's anchors stay where what holds them goes, for the links that lead there.
  const anchors = (element: Element) => element.querySelectorAll('a[id^="reader-"]')

  const heading = body.querySelector("h1, h2, h3, h4, h5, h6")
  if (heading && letters(heading.textContent) === letters(title)) heading.replaceWith(...anchors(heading))

  // A list of links within the page is its table of contents, which leads
  // nowhere once the page is gone; a book's leads to its chapters, and stays.
  for (const list of body.querySelectorAll("ul, ol")) {
    const links = Array.from(list.querySelectorAll("a"))
    const inPage = links.every((link) => /^#(?!reader-)/.test(link.getAttribute("href") ?? ""))
    const onlyLinks = letters(list.textContent) === links.map((link) => letters(link.textContent)).join("")
    if (links.length > 2 && inPage && onlyLinks) list.remove()
  }

  // Punctuation left on its own: a quote mark or bullet that was decoration,
  // where a book's link, as a note's back to its mark, ↩, is not.
  for (const paragraph of body.querySelectorAll("p")) {
    if (!/[\p{L}\p{N}]/u.test(paragraph.textContent!) && !paragraph.querySelector('img, math, a[href^="#reader-"]')) {
      paragraph.replaceWith(...anchors(paragraph))
    }
  }

  // Code in a line is its text alone, as Markdown marks nothing up within it:
  // a link in it, as a name in a reference often is, leads from all of it.
  for (const code of body.querySelectorAll("code")) {
    if (code.closest("pre")) continue
    code.before(...anchors(code))
    const link = code.querySelector("a[href]")?.cloneNode()
    code.textContent = code.textContent
    if (link) code.replaceWith(link)
    link?.appendChild(code)
  }

  // A link around blocks, as a card of a picture and a title is, can't be
  // written in Markdown: it leads from its first words, and its blocks stand.
  for (const link of body.querySelectorAll("a[href]")) {
    const blocks = Array.from(link.querySelectorAll("*")).filter((element) => OWN_BLOCK.test(element.nodeName))
    if (!blocks.length) continue
    const words = blocks.find((block) => block.textContent!.trim() && !blocks.some((inner) => inner !== block && block.contains(inner)))
    if (words) {
      const leading = link.cloneNode() as Element
      leading.append(...words.childNodes)
      words.append(leading)
    }
    link.replaceWith(...link.childNodes)
  }

  // A table in Markdown is its cells alone: what it holds outside them comes
  // before it, its caption set as a figure's is.
  for (const table of body.querySelectorAll("table")) {
    table.before(...Array.from(anchors(table)).filter((anchor) => !anchor.closest("td, th, caption")))
  }
  for (const caption of body.querySelectorAll("caption")) {
    const figcaption = body.ownerDocument.createElement("figcaption")
    figcaption.append(...caption.childNodes)
    caption.parentElement!.before(figcaption)
    caption.remove()
  }

  // A heading or a table's cell is one line in Markdown: a break in one is a space.
  for (const br of body.querySelectorAll(":is(h1, h2, h3, h4, h5, h6, td, th) br")) {
    if (br.closest("h1, h2, h3, h4, h5, h6") || grid(br.closest("table"))) br.replaceWith(" ")
  }

  // A line break that ends a block, or comes just before one, breaks nothing,
  // and in Markdown would be a backslash left showing.
  for (const br of body.querySelectorAll("br")) {
    let next = br.nextSibling
    while (next?.nodeType === 3 && !next.textContent!.trim()) next = next.nextSibling
    if ((!next || OWN_BLOCK.test(next.nodeName)) && !br.closest("pre")) br.remove()
  }

  // A note or warning, as Defuddle standardizes one: a quote led by its title.
  for (const callout of body.querySelectorAll(".callout")) {
    const quote = body.ownerDocument.createElement("blockquote")
    const title = callout.querySelector(".callout-title")
    if (title) {
      const label = body.ownerDocument.createElement("strong")
      label.textContent = title.textContent!.trim()
      title.replaceWith(label)
    }
    quote.append(...callout.childNodes)
    callout.replaceWith(quote)
  }

  // A "!" just before a link is marked, to be escaped; not in code, which is
  // written as it is.
  for (const link of body.querySelectorAll("a[href]")) {
    const before = link.previousSibling
    if (before?.nodeType === 3 && before.textContent!.endsWith("!") && !link.closest("pre")) {
      before.textContent = before.textContent!.slice(0, -1) + BANG_BEFORE_LINK
    }
  }

  grouped(body)
  return turndown.turndown(body).trim()
}

/** Containers whose children can be set in divs without changing what they write. */
const CONTAINER = /^(BODY|DIV|SECTION|ARTICLE|MAIN)$/
const GROUP = 32

/** Turndown joins each child's Markdown to the whole of its siblings' before
 *  it, a time that grows with the square of their number: fifty thousand
 *  paragraphs took eight seconds, and a book of a million lines, hours. So a
 *  container's children are set in divs of GROUP, and those in divs again,
 *  until it has GROUP at most; a div writes what it holds as a block of its
 *  own, so they are parted only where a block already parts them. */
function grouped(container: Element): void {
  for (const child of container.children) if (CONTAINER.test(child.nodeName)) grouped(child)
  while (container.childNodes.length > GROUP) {
    const groups: ChildNode[][] = [[]]
    for (const node of container.childNodes) {
      const group = groups.at(-1)!
      const parted = OWN_BLOCK.test(group.at(-1)?.nodeName ?? "") || OWN_BLOCK.test(node.nodeName)
      if (group.length >= GROUP && parted) groups.push([node])
      else group.push(node)
    }
    if (groups.length === 1) return
    container.replaceChildren(...groups.map((nodes) => {
      const div = container.ownerDocument.createElement("div")
      div.append(...nodes)
      return div
    }))
  }
}

const markdownIt = new MarkdownIt({ html: true })
  .use(footnote)
  // As MathML, which browsers draw themselves; temml trusts no command that
  // could link or load, such as \href.
  .use(tex, { render: (latex, displayMode) => temml.renderToString(latex, { displayMode }) })

// HTML written into an article's Markdown is the page's own and could do
// anything. A superscript, a subscript or a book's anchor is let through, its
// tag written anew; all else is dropped. markdown-it hands over each tag on
// its own, so an anchor is written whole from its opening tag.
markdownIt.renderer.rules.html_inline = (tokens, i) => {
  const html = tokens[i].content.trim()
  const id = /^<a id="([^"]*)">$/.exec(html)?.[1]
  if (id && ANCHOR.test(id)) return `<a id="${id}"></a>`
  const tag = /^<(\/?)(sup|sub)\b[^>]*>$/i.exec(html)
  return tag ? `<${tag[1]}${tag[2].toLowerCase()}>` : ""
}
markdownIt.renderer.rules.html_block = () => ""

/** An article's Markdown as the reading view shows it, and its words, as
 *  search reads them, they are counted and highlights quote them; the reading
 *  view finds the same text in the page (see lib/dom). markdown-it writes no
 *  link that could run a script, as a javascript: one would, and ends each
 *  block with a line break, which keeps the words of one apart from the next's. */
export function render(markdown: string): { html: string; text: string } {
  const body = withListText(bodyOf(markdownIt.render(markdown)))
  return { html: body.innerHTML, text: body.textContent!.replace(/\s+/g, " ").trim() }
}

/** A list item holding a list has words of its own beside it, which are in
 *  no block as lib/dom counts them, the innermost only; so each run
 *  of them is set in a paragraph, for the voice to read. */
function withListText(body: HTMLElement): HTMLElement {
  for (const li of body.querySelectorAll("li")) {
    if (!li.querySelector("ul, ol, p")) continue
    let paragraph: HTMLElement | null = null
    for (const node of [...li.childNodes]) {
      if (/^(P|UL|OL|BLOCKQUOTE|PRE|DIV)$/.test(node.nodeName)) paragraph = null
      else if (paragraph || node.textContent!.trim()) {
        paragraph ??= li.insertBefore(body.ownerDocument.createElement("p"), node)
        paragraph.append(node)
      }
    }
  }
  return body
}

const ESCAPED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"' }

/** The pace reading time is counted at, in words a minute. */
export const WORDS_PER_MINUTE = 230

/** An article's contents, in order, from its headings as render writes them:
 *  each with its place among them, by which the reading view finds it, and the
 *  minutes it takes to read, up to the next entry at its level or above. A
 *  book's are the headings it leads to, from its table of contents or its
 *  links, which alone begin with an anchor (see lib/formats/epub), at any level: its
 *  title page's or a passage's are not its contents. Another article's are its
 *  first three levels. */
export function contentsOf(html: string): { level: number; text: string; place: number; minutes: number }[] {
  const headings = Array.from(html.matchAll(/<h([1-6])>([\s\S]*?)<\/h\1>/g), ({ 1: level, 2: inner, index }, place) => ({
    level: Number(level),
    text: inner.replace(/<[^>]*>/g, "")
      .replace(/&(?:(amp|lt|gt|quot)|#(\d+)|#x([\da-f]+));/gi, (_, name?: string, decimal?: string, hex?: string) =>
        name ? ESCAPED[name] : String.fromCodePoint(decimal ? Number(decimal) : parseInt(hex!, 16)))
      .trim(),
    place,
    start: index,
    anchored: inner.startsWith('<a id="reader-'),
  }))
  const book = headings.some((heading) => heading.anchored)
  const entries = headings.filter((heading) => heading.text && (book ? heading.anchored : heading.level <= 3))
  return entries.map(({ level, text, place, start }, at) => {
    const end = entries.find((next, after) => after > at && next.level <= level)?.start ?? html.length
    const words = wordCount(html.slice(start, end).replace(/<[^>]*>/g, " "))
    return { level, text, place, minutes: Math.max(1, Math.round(words / WORDS_PER_MINUTE)) }
  })
}

/** Where each picture an article's Markdown shows is shown from, in order. */
export function imagesOf(markdown: string): string[] {
  return markdownIt.parse(markdown, {})
    .flatMap((token) => token.children ?? [])
    .flatMap((token) => (token.type === "image" ? [String(token.attrGet("src"))] : []))
}

/** Chinese and Japanese characters, which are written with no spaces between words. */
const HAN_AND_KANA = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g

/** How many words render gave, which the minutes an article takes are counted
 *  from: a Chinese or Japanese character takes about a word's time to read. */
export const wordCount = (text: string): number =>
  (text.match(HAN_AND_KANA)?.length ?? 0) + text.replace(HAN_AND_KANA, " ").split(/\s+/).filter(Boolean).length
