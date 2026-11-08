/**
 * How the page looks, as the user set it in this browser: theme, typeface,
 * text size, line height and column width. Applied by a script before the page
 * is painted, so a dark-theme user never sees a white frame, and again by the menu
 * that sets it.
 */

export type Appearance = { theme: "auto" | "light" | "dark"; font: "sans" | "serif"; size: number; lineHeight: number; width: number }

export const KEY = "brainy.appearance"

/** Text sizes in px, line heights in multiples of the text size, and column widths in rem. */
export const SIZES = [15, 17, 19, 21, 23, 26, 30]
export const LINE_HEIGHTS = { Tight: 1.5, Normal: 1.7, Loose: 1.9 }
export const WIDTHS = { Narrow: 42, Normal: 52, Wide: 64 }

/** Set the page to an appearance, the defaults filling what it leaves out.
 *  Self-contained: the script in the layout runs it from its own source. */
export function applyAppearance(stored: Partial<Appearance>): Appearance {
  const a: Appearance = { theme: "auto", font: "sans", size: 17, lineHeight: 1.7, width: 52, ...stored }
  const root = document.documentElement
  const dark = a.theme === "dark" || (a.theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches)
  root.classList.toggle("dark", dark)
  root.style.setProperty("--article-font", a.font === "serif" ? "var(--font-reading)" : "var(--font-sans)")
  root.style.setProperty("--article-size", `${a.size}px`)
  root.style.setProperty("--article-line-height", String(a.lineHeight))
  root.style.setProperty("--column", `${a.width}rem`)
  return a
}
