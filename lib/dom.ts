/**
 * The article on the page, as the voice and the highlights find their way in
 * it. The voice reads its blocks, its paragraphs, headings, list items, quotes
 * and formulas set on lines of their own, one after another. A highlight
 * quotes its text, the same text the server keeps (see render in
 * lib/markdown). Both draw with the CSS Custom Highlight API, which leaves the
 * article's HTML untouched. Browser-only but for ARTICLE_ID, which the server
 * renders the article with.
 */

/** The id of the reading view's article, which the voice, the highlights and
 *  the progress bar all work on, and nothing else on the page. */
export const ARTICLE_ID = "article"
export const articleElement = () => document.getElementById(ARTICLE_ID)!

/** The innermost of these, so a paragraph inside a list item or a quote counts once. */
const BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, math[display="block"]'

export function blocksOf(article: HTMLElement): HTMLElement[] {
  return [...article.querySelectorAll<HTMLElement>(BLOCK)].filter(
    (block) => !block.querySelector(BLOCK) && block.textContent!.trim(),
  )
}

/** Draw ranges under a name the stylesheet colours; with none, clear it. */
export function mark(name: string, ranges: Range[]) {
  if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") return
  if (ranges.length) CSS.highlights.set(name, new Highlight(...ranges))
  else CSS.highlights.delete(name)
}

/** Characters start to end of a block's text, across however many text nodes they span. */
export function rangeOf(block: HTMLElement, start: number, end: number): Range {
  const range = document.createRange()
  range.selectNodeContents(block)
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  let at = 0
  let started = false
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent!.length
    if (!started && start <= at + length) {
      range.setStart(node, start - at)
      started = true
    }
    if (end <= at + length) {
      range.setEnd(node, end - at)
      break
    }
    at += length
  }
  return range
}

/** The article's text as the server keeps it, each run of space one space,
 *  and where on the page any of it is: the range of characters start to end,
 *  and the place in the text of a point on the page. */
export type PageText = { text: string; range: (start: number, end: number) => Range; indexOf: (node: Node, offset: number) => number }

export function textOfPage(article: HTMLElement): PageText {
  const nodes: Text[] = []
  const offsets: number[] = []
  let text = ""
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    for (let i = 0; i < node.data.length; i++) {
      const space = /\s/.test(node.data[i])
      if (space && (!text || text.endsWith(" "))) continue
      text += space ? " " : node.data[i]
      nodes.push(node)
      offsets.push(i)
    }
  }
  if (text.endsWith(" ")) text = text.slice(0, -1)
  return {
    text,
    range(start, end) {
      const range = document.createRange()
      range.setStart(nodes[start], offsets[start])
      range.setEnd(nodes[end - 1], offsets[end - 1] + 1)
      return range
    },
    // The characters before the point, counted as the text counts them.
    indexOf(node, offset) {
      const before = document.createRange()
      before.setStart(article, 0)
      before.setEnd(node, offset)
      return Math.min(text.length, before.toString().replace(/\s+/g, " ").trimStart().length)
    },
  }
}
