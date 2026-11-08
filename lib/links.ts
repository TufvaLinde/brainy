/**
 * Links listed in a file, each to be saved as an article of its own: a feed's
 * newest items, an OPML file's feeds, each subscribed to once it is read,
 * browser bookmarks, a CSV with a URL column (as Pocket, Instapaper, Raindrop,
 * Readwise and Matter export), Omnivore's metadata JSON, a text of nothing but
 * links (one per line, or OneTab's "url | title"), or a zip of any of these.
 * Server-only.
 */

import { parseHTML } from "linkedom"
import { unzip } from "@/lib/files"

export type ArticleLink = { url: string; title?: string }

/** As many links as a feed brings in at once. */
const FEED_LINKS = 50

/** A link, if it is one to the web; a title is kept if it says something. */
const linked = (url: unknown, title?: unknown): ArticleLink[] =>
  typeof url === "string" && /^https?:\/\//i.test(url.trim()) && URL.canParse(url.trim())
    ? [{ url: url.trim(), title: (typeof title === "string" && title.trim()) || undefined }]
    : []

/** An RSS, Atom or JSON feed's items, newest first as feeds list them; none
 *  if it is a feed that lists nothing, null if it is no feed. */
export function parseFeed(text: string, base: string): ArticleLink[] | null {
  let items: { url?: unknown; title?: unknown }[]
  if (/<(?:rss|feed|rdf:RDF)\b/i.test(text.slice(0, 4096))) {
    const { DOMParser } = parseHTML("")
    const feed = new DOMParser().parseFromString(text, "text/xml")
    items = Array.from(feed.querySelectorAll("item, entry"), (item) => {
      const link = item.querySelector('link[rel="alternate"], link:not([rel])')
      const href = (link?.getAttribute("href") ?? link?.textContent ?? "").trim()
      return { url: URL.parse(href, base || undefined)?.href, title: item.querySelector("title")?.textContent }
    })
  } else {
    const feed = parsed(text)
    if (!/^https:\/\/jsonfeed\.org\/version\//.test(feed?.version)) return null
    items = Array.isArray(feed.items) ? feed.items.map((item: Record<string, unknown>) => ({ url: item?.url ?? item?.external_url, title: item?.title })) : []
  }
  return items.slice(0, FEED_LINKS).flatMap((item) => linked(item.url, item.title))
}

/** The links a file lists, or null if it is not a list of links. */
export function parseLinkList(bytes: Uint8Array, name: string, type: string): ArticleLink[] | null {
  const extension = /\.(\w+)$/.exec(name)?.[1]?.toLowerCase() ?? ""
  if (extension === "zip" || /^application\/(?:x-)?zip/.test(type)) {
    let entries: Record<string, Uint8Array>
    try {
      entries = unzip(bytes)
    } catch {
      return null
    }
    const lists = Object.entries(entries)
      .filter(([path]) => !path.startsWith("__MACOSX/") && !/\.zip$/i.test(path))
      .flatMap(([path, entry]) => parseLinkList(entry, path, "") ?? [])
    return lists.length ? lists : null
  }

  const text = new TextDecoder().decode(bytes)
  if (/^\s*<!DOCTYPE NETSCAPE-Bookmark-file-1>/i.test(text) || /<title>Pocket Export<\/title>/i.test(text.slice(0, 1024))) {
    // Bookmarks write HREF, which linkedom keeps as written.
    return Array.from(parseHTML(text).document.querySelectorAll("a"), (a) => linked(a.getAttribute("href") ?? a.getAttribute("HREF"), a.textContent)).flat()
  }
  if (/<opml\b/i.test(text.slice(0, 1024))) {
    const { DOMParser } = parseHTML("")
    const opml = new DOMParser().parseFromString(text, "text/xml")
    return Array.from(opml.querySelectorAll("outline[xmlUrl]"), (feed) => linked(feed.getAttribute("xmlUrl"), feed.getAttribute("text"))).flat()
  }
  if (extension === "csv" || /^text\/csv/.test(type)) {
    const [header = [], ...rows] = rowsOf(text)
    const column = (name: string) => header.findIndex((cell) => cell.trim().toLowerCase() === name)
    const url = column("url")
    if (url < 0) return null
    const title = column("title")
    return rows.flatMap((row) => linked(row[url], row[title]))
  }
  if (extension === "json" || /json/.test(type)) {
    const value = parsed(text)
    if (Array.isArray(value) && value.length && value.every((item) => typeof item?.url === "string")) {
      return value.flatMap((item) => linked(item.url, item.title))
    }
    return parseFeed(text, "")
  }
  if (["", "txt", "text"].includes(extension) || /^text\/(?:plain|uri-list)/.test(type)) {
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean)
    const listed = lines.map((line) => /^(https?:\/\/\S+)(?:\s+\|\s+(.*))?$/.exec(line))
    return lines.length && listed.every(Boolean) ? listed.flatMap((match) => linked(match![1], match![2])) : null
  }
  return /^(?:xml|rss|atom)$/.test(extension) || /xml/.test(type) ? parseFeed(text, "") : null
}

function parsed(text: string) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** A CSV's rows as RFC 4180 writes them: a quoted field may hold commas,
 *  line breaks and doubled quotes. */
function rowsOf(csv: string): string[][] {
  const rows: string[][] = [[]]
  let field = ""
  let quoted = false
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i]
    if (quoted) {
      if (c !== '"') field += c
      else if (csv[i + 1] === '"') field += csv[i++]
      else quoted = false
    } else if (c === '"') quoted = true
    else if (c === ",") {
      rows.at(-1)!.push(field)
      field = ""
    } else if (c === "\n") {
      rows.at(-1)!.push(field.replace(/\r$/, ""))
      field = ""
      rows.push([])
    } else field += c
  }
  rows.at(-1)!.push(field)
  return rows
}
