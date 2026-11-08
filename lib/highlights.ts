/**
 * What the reader marked in an article: a quote of its text (see render in
 * lib/markdown), the words either side that tell it apart, where it was, and a
 * note if one was written. A quote is found by its words, not where it was, so
 * it stays found when the article is read again by newer rules; one that can't
 * be told apart from another is never placed at either. Used by the browser and
 * the server alike.
 */

export type Quote = { quote: string; prefix: string; suffix: string; position: number }
export type Highlight = Quote & { id: number; note: string }

export class HighlightConflict extends Error {
  constructor() { super("The updated article no longer contains a highlight. Your saved article was kept.") }
}

/** Longer than any passage worth marking, or note worth writing. */
const MAX_TEXT = 10_000
/** Words enough either side of a quote to tell it apart from the same words elsewhere. */
const CONTEXT = 32

/** The quote of text from start to end. */
export function quoteOf(text: string, start: number, end: number): Quote {
  return { quote: text.slice(start, end), prefix: text.slice(Math.max(0, start - CONTEXT), start), suffix: text.slice(end, end + CONTEXT), position: start }
}

/** Where a quote starts in text: where it was, if it is there still with the
 *  words around it; else where it is found once, or once with those words.
 *  Null if it isn't found, or is found in places its words can't tell apart. */
export function anchor({ quote, prefix, suffix, position }: Quote, text: string): number | null {
  const fits = (at: number) => text.endsWith(prefix, at) && text.startsWith(suffix, at + quote.length)
  if (text.startsWith(quote, position) && fits(position)) return position
  const found: number[] = []
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) found.push(at)
  if (found.length === 1) return found[0]
  const fitting = found.filter(fits)
  return fitting.length === 1 ? fitting[0] : null
}

/** Check that the browser quoted the article's text, where it says it did. */
export function validateQuote(quote: Quote, text: string): void {
  const strings = [quote.quote, quote.prefix, quote.suffix].every((part) => typeof part === "string")
  if (!strings || !quote.quote.trim() || quote.quote.length > MAX_TEXT || quote.prefix.length > CONTEXT || quote.suffix.length > CONTEXT
    || !Number.isInteger(quote.position) || quote.position < 0) {
    throw new Error("Not a quote of the article")
  }
  if (anchor(quote, text) !== quote.position) throw new Error("The article changed. Reload it before highlighting this passage.")
}

/** A valid note, with surrounding whitespace removed. */
export function validateNote(note: string): string {
  if (typeof note !== "string" || note.length > MAX_TEXT) throw new Error("Not a note")
  return note.trim()
}

/** Highlights as Markdown: each a quote, followed by its note. */
export const highlightsMarkdown = (highlights: readonly Pick<Highlight, "quote" | "note">[]): string =>
  highlights.map((h) => `> ${h.quote}${h.note ? `\n\n${h.note}` : ""}`).join("\n\n")
