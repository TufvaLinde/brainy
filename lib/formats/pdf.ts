/** PDF, its text read back into the article it was set from. */
import { getDocumentProxy } from "unpdf"
import { escapeHtml, ImportError } from "@/lib/files"

type Run = { text: string; x: number; y: number; end: number; size: number; font: string; rtl: boolean }
type Line = { page: number; x: number; y: number; end: number; size: number; code: boolean; text: string }
type Block = { kind: "heading" | "text" | "code" | "bullet" | "number"; page: number; size: number; x: number; end: number; lines: Line[] }

/** Writing set with no spaces between its words: Chinese and Japanese. */
const CJK = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/
const CJK_SPACE = new RegExp(`(${CJK.source}) +(?=${CJK.source})`, "g")
/** What ends a sentence, as a paragraph's last line does. */
const ENDS = /[.!?:;。！？]["'”’)\]]*$/
const BULLET = /^[•◦▪▫‣⁃●○■□►➢✓*-]\s+(?=\S)/
const NUMBERED = /^(\d{1,3})[.)]\s+(?=\S)/
/** A caption's number is set apart, where a sentence's, "Figure 7 shows", runs on. */
const CAPTION = /^(?:Fig(?:ure)?|FIG(?:URE)?|Table|TABLE|Chart|Listing|Exhibit)\.?\s*\d+(?:\.\d+)*(?:[.:|]|\s+[A-Z])/

/** The key counted most often. */
const most = <T,>(counts: Map<T, number>): T | undefined => [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]

/** A PDF's text as an article. A PDF places each run of text on its page and
 *  says nothing of what it is part of, so: a line is the runs on one level,
 *  right to left where their script is; a paragraph, lines set close under one
 *  another, carried on into the next column or page if it ended unfinished,
 *  past any notes set smaller at its foot; a heading, larger lines; a list,
 *  lines led by a bullet or a number; code, lines in a monospaced font other
 *  than the text's, kept as they are set. What recurs at the head or foot of
 *  the pages, or numbers them, is no part of it, nor a table of contents'
 *  dotted lines to page numbers. A scanned page has no text. */
export async function pdfToHtml(bytes: Uint8Array): Promise<{ title: string; author: string; html: string }> {
  // A copy, as pdf.js takes the bytes it is given for its own and leaves them unreadable.
  const pdf = await getDocumentProxy(new Uint8Array(bytes)).catch((error: Error) => {
    throw error.name === "PasswordException" ? new ImportError("That PDF is locked with a password: unlock it and upload it again") : error
  })
  try {
    const pages: { height: number; runs: Run[] }[] = []
    const monospaced = new Set<string>()
    // The width a character of each font's runs of letters takes, for its size.
    const advances = new Map<string, number[]>()
    for (let number = 1; number <= pdf.numPages; number++) {
      // A page that can't be read is passed over, and the rest read.
      const page = await pdf.getPage(number).catch(() => null)
      const content = await page?.getTextContent().catch(() => null)
      if (!page || !content) {
        pages.push({ height: 0, runs: [] })
        continue
      }
      for (const [font, style] of Object.entries(content.styles)) if (style.fontFamily === "monospace") monospaced.add(font)
      const runs = content.items.flatMap((item) => {
        // Text turned on its side, such as arXiv's stamp in the margin, is no
        // part of the article; italic, slanted by a shear, is.
        if (!("str" in item) || item.transform[1] || item.transform[0] <= 0) return []
        // Some fonts map glyphs to control characters, which no text holds, and Postgres refuses NUL.
        const text = item.str.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
        // Its size is its letters' height, which pdf.js stretches along a slant.
        const [, , , size, x, y] = item.transform
        // Measured at the size as set, not rounded: code is often set at 10.5.
        // Han and kana are as wide as each other in any font, and tell nothing.
        if ((text.match(/\p{L}/gu)?.length ?? 0) >= 3 && size && !CJK.test(text)) {
          if (!advances.has(item.fontName)) advances.set(item.fontName, [])
          advances.get(item.fontName)!.push(item.width / text.length / size)
        }
        return [{ text, x, y, end: x + item.width, size: Math.round(size), font: item.fontName, rtl: item.dir === "rtl" }]
      })
      pages.push({ height: page.getViewport({ scale: 1 }).height, runs })
    }
    const { info } = ((await pdf.getMetadata().catch(() => null)) ?? { info: {} }) as { info: { Title?: string; Author?: string } }

    // The text's size and font are those most of its characters are set in.
    const sizes = new Map<number, number>()
    const fonts = new Map<string, number>()
    for (const run of pages.flatMap((page) => page.runs)) {
      if (!run.text.trim()) continue
      sizes.set(run.size, (sizes.get(run.size) ?? 0) + run.text.length)
      fonts.set(run.font, (fonts.get(run.font) ?? 0) + run.text.length)
    }
    const body = most(sizes)
    if (!body) return { title: "", author: "", html: "" }
    // A font is monospaced if pdf.js knows it is, or if nearly every run of
    // letters in it takes the same width a character: an ellipsis can take two.
    for (const [font, measured] of advances) {
      const median = measured.toSorted((a, b) => a - b)[measured.length >> 1]
      const even = measured.filter((advance) => Math.abs(advance - median) < median * 0.005).length
      if (measured.length >= 3 && even >= measured.length * 0.9) monospaced.add(font)
    }
    // Code is set apart in a font of its own: a text all set in one, as a typescript is, is no code.
    monospaced.delete(most(fonts)!)

    const lineOf = (runs: Run[], page: number): Line => {
      const words = runs.filter((run) => run.text.trim())
      // Han and kana are as wide as each other in any font; a callout's ① or a
      // tree's ├── may come from another font. Neither tells code.
      const mono = (run: Run) => monospaced.has(run.font) && !CJK.test(run.text)
      const code = words.some(mono) && words.every((run) => mono(run) || !/[\p{L}\p{P}]/u.test(run.text))
      const rtl = words.filter((run) => run.rtl).reduce((sum, run) => sum + run.text.length, 0) * 2 > words.reduce((sum, run) => sum + run.text.length, 0)
      const pieces: string[] = []
      let before: Run | undefined
      for (const run of runs.toSorted((a, b) => a.x - b.x)) {
        // In code, the gap between runs says how many spaces there are.
        if (code && !run.text.trim()) continue
        const gap = before ? run.x - before.end : 0
        if (before && code) pieces.push(" ".repeat(Math.max(0, Math.round(gap / ((before.end - before.x) / before.text.length)))))
        else if (before && gap > body * 0.15 && !/\s$/.test(before.text) && !/^\s/.test(run.text) && !(CJK.test(before.text.at(-1)!) && CJK.test(run.text[0]))) pieces.push(" ")
        pieces.push(run.text)
        before = run
      }
      if (rtl) pieces.reverse()
      // Arabic in the forms its letters take where they fall in a word is written as its letters.
      const text = pieces.join("").replace(/[\ufb50-\ufdff\ufe70-\ufefe]+/g, (shaped) => shaped.normalize("NFKC"))
      const x = Math.min(...runs.map((run) => run.x))
      const end = Math.max(...runs.map((run) => run.end))
      // Its size is most of its characters', as a large bracket in a formula, or a small superscript, is not.
      const sizes = new Map<number, number>()
      for (const run of words) sizes.set(run.size, (sizes.get(run.size) ?? 0) + run.text.length)
      const size = most(sizes)!
      return { page, x, y: words[0].y, end, size, code, text: code ? text.trimEnd() : text.trim().replace(/\s+/g, " ").replace(CJK_SPACE, "$1") }
    }
    const lines: Line[] = []
    pages.forEach(({ runs }, page) => {
      let line: Run[] = []
      for (const run of runs) {
        const first = line[0]
        // A superscript sits a little higher, still on its line.
        const onLine = first && Math.abs(first.y - run.y) < body * 0.7 &&
          (run.x >= Math.max(...line.map((r) => r.end)) - 1 || (run.rtl && run.end <= Math.min(...line.map((r) => r.x)) + 1))
        if (onLine) line.push(run)
        else if (run.text.trim()) {
          if (line.length) lines.push(lineOf(line, page))
          line = [run]
        }
      }
      if (line.length) lines.push(lineOf(line, page))
    })

    // A page's head and foot are its first two lines and its last two, near the
    // sheet's edges, or where most pages' text starts or ends, as a small
    // book's pages set within a larger sheet have them; a running head or foot
    // recurs on many pages, or numbers its page as the others do theirs.
    const onPages = Map.groupBy(lines, (line) => line.page)
    const median = (values: number[]) => values.toSorted((a, b) => a - b)[values.length >> 1]
    const top = median([...onPages.values()].map((onPage) => Math.max(...onPage.map((line) => line.y))))
    const foot = median([...onPages.values()].map((onPage) => Math.min(...onPage.map((line) => line.y))))
    const edges = new Set<Line>()
    for (const [page, onPage] of onPages) {
      const levels = [...new Set(onPage.map((line) => Math.round(line.y)))].sort((a, b) => b - a)
      const outer = new Set([...levels.slice(0, 2), ...levels.slice(-2)])
      const { height } = pages[page]
      const near = (y: number) => y > height * 0.88 || y < height * 0.12 || Math.abs(y - top) < 2 || Math.abs(y - foot) < 2
      for (const line of onPage) if (outer.has(Math.round(line.y)) && near(line.y)) edges.add(line)
    }
    // Its page number aside, at either end, as odd and even pages set it apart.
    const shape = (line: Line) => line.text.replace(/^\d+\s+|\s+\d+$/g, "").replace(/\d+/g, "#")
    // A number at either end, set apart by a space: "2. Transactions" numbers its section, not its page.
    const numbers = (line: Line) => [/^\d+(?=\s)/.exec(line.text), /(?<=\s)\d+$/.exec(line.text)].flatMap((found) => (found ? [Number(found[0])] : []))
    const shapes = new Map<string, Set<number>>()
    const offsets = new Map<number, Set<number>>()
    for (const line of edges) {
      shapes.set(shape(line), (shapes.get(shape(line)) ?? new Set()).add(line.page))
      for (const number of numbers(line)) offsets.set(number - line.page, (offsets.get(number - line.page) ?? new Set()).add(line.page))
    }
    const often = (pages: Set<number> | undefined, share: number) => (pages?.size ?? 0) >= Math.max(3, pdf.numPages * share)
    const offset = [...offsets].filter(([, pages]) => often(pages, 1 / 4)).sort((a, b) => b[1].size - a[1].size)[0]?.[0]
    const running = (line: Line) =>
      /^(?:page\s+)?(?:\d+|[ivxlc]{1,6})(?:\s*(?:of|\/)\s*\d+)?$/i.test(line.text) || often(shapes.get(shape(line)), 1 / 2) ||
      (offset !== undefined && line.size <= body * 1.15 && numbers(line).includes(line.page + offset))
    const kept = lines.filter((line) => !(edges.has(line) && running(line)) && !(!line.code && /(?:\s?\.){4,}\s*(?:\d+|[ivxlc]+)$/i.test(line.text)))
    if (!kept.length) return { title: info.Title?.trim() ?? "", author: "", html: "" }

    // The space from one line of the text to the next, as most are set.
    const gaps = new Map<number, number>()
    kept.forEach((line, i) => {
      const above = kept[i - 1]
      const gap = above?.page === line.page && above.size === body && line.size === body ? Math.round((above.y - line.y) * 2) / 2 : 0
      if (gap > 0 && gap < body * 3) gaps.set(gap, (gaps.get(gap) ?? 0) + 1)
    })
    const leading = most(gaps) ?? body * 1.2
    // A heading is a line or two: a larger size that runs on for four lines or
    // more, page after page, is the text's too, as a document's own is when a
    // longer index is set smaller.
    const runsOn = new Map<number, Set<number>>()
    let run = 0
    kept.forEach((line, i) => {
      run = kept[i - 1]?.page === line.page && kept[i - 1].size === line.size ? run + 1 : 1
      if (run === 4) runsOn.set(line.size, (runsOn.get(line.size) ?? new Set()).add(line.page))
    })
    const prose = (size: number) => (runsOn.get(size)?.size ?? 0) >= 3

    // A section numbered within another, "5.1 Raft basics", is titled on a line
    // of its own, often in bold in the text's size, which pdf.js doesn't tell.
    const titled = (line: Line) => /^\d+(?:\.\d+)+\.?\s+\p{Lu}/u.test(line.text) && !ENDS.test(line.text) && line.text.split(" ").length <= 10
    // Whether a line goes on with the block of the line above it in its column.
    const follows = (block: Block, above: Line, line: Line, kind: Block["kind"]) => {
      const gap = above.y - line.y
      if (kind === "code") return block.kind === "code"
      if (kind === "heading") return block.kind === "heading" && Math.abs(line.size - above.size) <= 1 && gap < line.size * 1.6
      if (kind !== "text" || block.kind === "heading" || block.kind === "code") return false
      // A reference's lines after its first are indented, under an unfinished first line as wide.
      const hanging = block.lines.length === 1 && !ENDS.test(above.text) && above.end >= line.end - body
      return Math.abs(line.size - above.size) <= 1 && gap <= leading * Math.max(1, line.size / body) + body * 0.35 &&
        // A paragraph's first line is indented, and its last falls short: a
        // little, after a sentence's end, or far, as a clause's or a verse's can.
        !(block.kind === "text" && line.x > above.x + body * 0.8 && !hanging) &&
        !(above.end < block.end - body * 2 && ENDS.test(above.text)) && !(above.end - block.x < (block.end - block.x) * 0.6) &&
        !(titled(line) && ENDS.test(above.text)) && !(block.lines.length === 1 && titled(above) && above.end < line.end - body * 2) &&
        // An item's lines after its first are set at its bullet or past it.
        (block.kind === "text" || line.x >= block.x - 1)
    }
    // Notes set smaller than the text, and captions, which a paragraph goes on past.
    const aside = (block: Block, size: number) => (block.kind === "text" && block.size < size - 1) || CAPTION.test(block.lines[0].text)
    // The paragraph a line carries on, at the head of a column or page or past a
    // figure: the last above it, past any asides, if it ended unfinished, and
    // the line is its words' next, not a label, which is short.
    const carried = (line: Line, kind: Block["kind"]) => {
      if (kind !== "text" || CAPTION.test(line.text)) return undefined
      const block = blocks.findLast((block) => !aside(block, line.size))
      if (!block || block.kind === "heading" || block.kind === "code" || Math.abs(block.size - line.size) > 1) return undefined
      const last = block.lines.at(-1)!
      const unfinished = !ENDS.test(last.text) && (block.lines.length > 1 || /[-\u00ad]$/.test(last.text))
      const next = /^\p{Ll}/u.test(line.text) || line.end - line.x >= (last.end - last.x) * 0.6
      return unfinished && next && line.page - last.page <= 1 ? block : undefined
    }
    const blocks: Block[] = []
    let current: Block | undefined
    for (const line of kept) {
      const above = current?.lines.at(-1)
      // A heading is in words: a formula set large is no heading, nor a diagram's letters.
      const letters = line.text.match(/\p{L}/gu)?.length ?? 0
      const worded = /\p{L}{2}/u.test(line.text) && letters * 2 >= line.text.replace(/\s/g, "").length
      const kind: Block["kind"] = line.code ? "code" : line.size > body * 1.15 && worded && !prose(line.size) ? "heading" : BULLET.test(line.text) ? "bullet"
        : NUMBERED.test(line.text) && (!above || current!.kind === "number" || ENDS.test(above.text) || NUMBERED.exec(line.text)![1] === "1") ? "number" : "text"
      const sameColumn = above?.page === line.page && above.y > line.y
      const target = !current || !above ? undefined
        : sameColumn && follows(current, above, line, kind) ? current
        : !sameColumn || aside(current, line.size) ? carried(line, kind) : undefined
      if (target) {
        // A paragraph carried on into another column, or past a figure, is measured there.
        if (target !== current || !sameColumn) Object.assign(target, { x: line.x, end: line.end })
        target.lines.push(line)
        target.end = Math.max(target.end, line.end)
        current = target
      } else blocks.push((current = { kind, page: line.page, size: line.size, x: line.x, end: line.end, lines: [line] }))
    }

    // A word broken across lines is joined again, keeping its hyphen if the
    // text writes it so elsewhere; or, if it never writes it whole, if each
    // half is a word it writes elsewhere, as "sequence-aligned" is. The pieces
    // of words broken across lines, "eration" and "tation", are no words.
    const seen = new Set<string>()
    kept.forEach((line, i) => {
      let text = line.text.toLowerCase().replace(/\p{L}+[-\u00ad]$/u, "")
      if (/[-\u00ad]$/.test(kept[i - 1]?.text ?? "")) text = text.replace(/^\p{L}+/u, "")
      for (const word of [...(text.match(/\p{L}+/gu) ?? []), ...(text.match(/\p{L}+-\p{L}+/gu) ?? [])]) seen.add(word)
    })
    const word = (half: string) => half.length >= 4 && seen.has(half)
    const joined = (text: string, next: string) => {
      const broken = /(\p{L}+)[-\u00ad]$/u.exec(text)
      const following = /^\p{Ll}+/u.exec(next)?.[0]
      if (broken && following) {
        const first = broken[1].toLowerCase()
        const compound = seen.has(`${first}-${following}`) || (!seen.has(first + following) && word(first) && word(following))
        return text.endsWith("-") && compound ? text + next : text.slice(0, -1) + next
      }
      return CJK.test(text.at(-1)!) && CJK.test(next[0]) ? text + next : `${text} ${next}`
    }
    const textOf = (block: Block) => block.lines.map((line) => line.text).reduce(joined)
    const codeOf = (block: Block) => {
      const left = Math.min(...block.lines.map((line) => line.x))
      const advance = block.lines.reduce((sum, line) => sum + line.end - line.x, 0) / block.lines.reduce((sum, line) => sum + line.text.length, 0)
      return block.lines.map((line, i) => {
        const above = block.lines[i - 1]
        const blank = above?.page === line.page && above.y - line.y > leading * 1.6 ? "\n" : ""
        return blank + " ".repeat(Math.max(0, Math.round((line.x - left) / advance))) + line.text
      }).join("\n")
    }

    // A heading leads into the text under it: large words that lead into a
    // figure's caption are the figure's own, back to a heading set smaller
    // than those after it, which leads into the figure.
    let after: number | undefined
    for (const block of blocks.toReversed()) {
      if (block.kind === "heading" && after !== undefined && block.size >= after) {
        block.kind = "text"
        after = block.size
      } else after = CAPTION.test(block.lines[0].text) ? 0 : undefined
    }
    // The title is the first page's largest text, which needn't come first: a
    // notice can sit above it. The PDF's own is often the name of a file it was
    // made from, so it comes second, and only if it isn't one.
    const largest = blocks.filter((block) => block.kind === "heading" && block.page === kept[0].page).sort((a, b) => b.size - a.size)[0]
    const named = info.Title?.trim() ?? ""
    const title = (largest && textOf(largest).length <= 300 ? textOf(largest) : "") || (/\.\w{2,5}$/.test(named) ? "" : named)
    for (const block of blocks) if (block.kind === "text" && block.lines.length === 1 && titled(block.lines[0])) block.kind = "heading"
    // A chapter's number, set apart above its title, makes one heading with it.
    const chapterNumbers = new Set<Block>()
    blocks.forEach((block, i) => {
      const next = blocks[i + 1]
      if (block.kind !== "heading" || next?.kind !== "heading" || !/^(?:chapter|part|book|appendix)\s+\S+$/i.test(textOf(block))) return
      next.lines.unshift({ ...block.lines[0], text: `${textOf(block)}:` })
      chapterNumbers.add(block)
    })
    // A table of contents lists the headings that follow, each by the page it is on.
    const headings = new Set(blocks.flatMap((block) => (block.kind === "heading" ? [textOf(block).toLowerCase()] : [])))
    const entry = (block: Block) => /^(.+?)\s+(?:\d+|[ivxlc]+)$/i.exec(block.lines[0].text)?.[1].toLowerCase()
    const shown = blocks.filter((block) => !chapterNumbers.has(block) && !(block.kind === "text" && block.lines.length === 1 && headings.has(entry(block)!)))
    // Headings rank by size, the largest the article's first level under its title.
    const levels = [...new Set(shown.filter((block) => block.kind === "heading" && textOf(block) !== title).map((block) => block.size))]
      .sort((a, b) => b - a)
    // A few words each a block of their own, set where few lines on their page
    // begin, three or more in a row, are a figure's labels, which make no
    // paragraphs: they're set on one line.
    const starts = new Map<string, number>()
    const start = (line: Line) => `${line.page} ${Math.round(line.x / 2)}`
    for (const line of kept) starts.set(start(line), (starts.get(start(line)) ?? 0) + 1)
    const onPage = Map.groupBy(kept, (line) => line.page)
    const label = (block?: Block) => {
      const line = block?.kind === "text" && block.lines.length <= 3 ? block.lines[0] : undefined
      return !!line && textOf(block!).split(" ").length <= 6 && starts.get(start(line))! < Math.max(3, onPage.get(line.page)!.length * 0.15)
    }
    let html = ""
    let list = ""
    for (let i = 0; i < shown.length; i++) {
      const block = shown[i]
      let labels = 0
      while (label(shown[i + labels])) labels++
      const text = labels >= 3 ? shown.slice(i, (i += labels - 1) + 1).map(textOf).join(" · ") : textOf(block)
      const tag = block.kind === "bullet" ? "ul" : block.kind === "number" ? "ol" : ""
      if (list && tag !== list) html += `</${list}>`
      if (tag && tag !== list) html += tag === "ol" ? `<ol start="${NUMBERED.exec(text)![1]}">` : "<ul>"
      list = tag
      if (tag) html += `<li>${escapeHtml(text.replace(tag === "ul" ? BULLET : NUMBERED, ""))}</li>`
      else if (block.kind === "code") html += `<pre><code>${escapeHtml(codeOf(block))}</code></pre>`
      else if (block.kind === "text") html += `<p>${escapeHtml(text)}</p>`
      else if (text !== title) {
        // A numbered section is a level deeper than the one it is numbered within, set in its size or not.
        const depth = /^\d+(?:\.\d+)*/.exec(text)?.[0].split(".").length ?? 0
        const level = Math.min(Math.max(2 + levels.indexOf(block.size), 1 + depth), 4)
        html += `<h${level}>${escapeHtml(text)}</h${level}>`
      }
    }
    if (list) html += `</${list}>`
    // An author is as often the account that made the file, which names no one: a name is two words or more.
    const author = info.Author?.trim() ?? ""
    return { title, author: /^[\p{Lu}\p{Lo}][\p{L}\p{M}.'’-]*(?:[\s,&]+[\p{L}\p{M}.'’-]+)+$/u.test(author) ? author : "", html }
  } finally {
    await pdf.loadingTask.destroy()
  }
}
