/**
 * A link, fetched: the source of the article at it, as it came, which is read
 * as any file is (see lib/formats), or, at a feed, the links it lists, each
 * to be fetched in turn, and again as it adds more (see lib/library). A page
 * the server can't get, the user's own browser can, and the bookmarklet
 * saves it from there.
 * And the pictures an article and its page name on the web, downloaded to be
 * kept with it as it is saved.
 *
 * A few sites are better read another way. Hacker News asks for few requests
 * and refuses many: a story of its own is read from its official API, and of
 * its feed only the top ten stories are kept up with. An arXiv paper is read
 * from its HTML version, the paper itself with its sections and maths. On
 * GitHub, a commit is read from its patch, as its page draws the diff as a
 * table. A file shown in a page of its own, on GitHub, Google Docs, Drive or
 * Dropbox, is read from the file itself. Bluesky gives a post and the posts its
 * author threaded under it; X a post, but not its thread, which only a browser
 * gets, by the bookmarklet; YouTube a video's title, channel and picture, but
 * not its transcript. What an API answers is the article's source, kept as it
 * came, and read by siteArticle, as any source is read again when the rules
 * change. Server-only.
 */

import { parseHTML } from "linkedom"
import type { EmbeddedImage, Source } from "@/lib/db"
import type { ExtractedArticle } from "@/lib/formats"
import { decode, escapeHtml, ImportError, MAX_BYTES, paragraphsOf, Pictures, readBytes, SizeLimit } from "@/lib/files"
import { parseFeed, type ArticleLink } from "@/lib/links"
import { imagesOf } from "@/lib/markdown"

// Who is asking, said plainly: a browser's name gets past some walls, but
// isn't true.
const HEADERS = {
  "user-agent": "Mozilla/5.0 (compatible; Brainy/1.0)",
  accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8",
  "accept-language": "en",
}

// Where the APIs some sites are read from answer: what one answered is read by siteArticle.
const STORY = "https://hacker-news.firebaseio.com/v0/item/"
const THREAD = "https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?"
const POST = "https://publish.twitter.com/oembed?"
const VIDEO = "https://www.youtube.com/oembed?"
const PATCH = /^https:\/\/github\.com\/[^/]+\/[^/]+\/commit\/[0-9a-f]+\.patch$/

// Hacker News' feed lists its front page; only its top stories are kept up with.
const TOP_STORIES = "https://news.ycombinator.com/rss"

const BROWSERS_ONLY = "The site lets only browsers in: open the page and save it with the bookmarklet"
const SUBSCRIBERS_ONLY = "The site shows all of it only to subscribers: open the page and save it with the bookmarklet"

/** What a link answers: an article's source, or a feed's items. */
export type Fetched = { source: Source } | { feed: ArticleLink[] }

export async function fetchLink(url: string): Promise<Fetched> {
  const story = /^https:\/\/news\.ycombinator\.com\/item\?id=(\d+)$/.exec(url)?.[1]
  if (story) return fetchStory(story)
  const paper = /^https:\/\/arxiv\.org\/(?:abs|pdf)\/(.+?)(?:\.pdf)?$/.exec(url)?.[1]
  const asHtml = paper ? await get(`https://arxiv.org/html/${paper}`) : null
  if (asHtml?.ok) return read(asHtml, asHtml.url)
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/commit\/[0-9a-f]+$/.test(url)) return fetchApi("GitHub", `${url}.patch`)
  const skeet = /^https:\/\/bsky\.app\/profile\/([^/]+)\/post\/(\w+)/.exec(url)
  if (skeet) return fetchApi("Bluesky", THREAD + new URLSearchParams({ uri: `at://${skeet[1]}/app.bsky.feed.post/${skeet[2]}`, parentHeight: "0" }))
  if (/^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/\w+\/status\/\d+/.test(url)) {
    return fetchApi("X", POST + new URLSearchParams({ url, omit_script: "1", dnt: "true" }), "X shows no public post at that link")
  }
  if (/^https:\/\/(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?|shorts\/)|youtu\.be\/)/.test(url)) {
    return fetchApi("YouTube", VIDEO + new URLSearchParams({ url, format: "json" }), "YouTube shows no public video at that link")
  }

  const file = fileBehind(url)
  const { response, base } = await fetchPage(file ?? url)
  const landed = new URL(response.url || base)
  if (landed.hostname === "accounts.google.com") {
    throw new ImportError("Google shows that file only to those signed in: share it with anyone with the link, or upload it")
  }
  // A site may send a server on to sign in, as a browser that is signed in isn't.
  if (response.redirected && /^(?:idp|login|signin|auth|sso|accounts?)\.|\/(?:log-?in|sign-?in|sso|authorize)\b/i.test(landed.hostname + landed.pathname)) {
    throw new ImportError(BROWSERS_ONLY)
  }
  // The file is the page's, and is named for it.
  const fetched = await read(response, file ? url : base)
  return url === TOP_STORIES && "feed" in fetched ? { feed: fetched.feed.slice(0, 10) } : fetched
}

/** What a link answers, if it starts to within 15 seconds, however long all
 *  of it then takes: fetch gives up on one that stops for five minutes. */
async function get(url: string): Promise<Response | null> {
  const waiting = new AbortController()
  const timer = setTimeout(() => waiting.abort(), 15_000)
  // Hacker News' feed refuses a browser's name from what it can tell is no browser.
  const headers = url === TOP_STORIES ? { ...HEADERS, "user-agent": "Brainy/1.0" } : HEADERS
  try {
    return await fetch(url, { headers, signal: waiting.signal })
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** The page at a link, and the address its own links are relative to. */
async function fetchPage(url: string): Promise<{ response: Response; base: string }> {
  const response = await get(url)
  if (response?.ok) return { response, base: response.url }
  if (!response) throw new ImportError("Couldn't reach the site")
  if (response.status === 402) throw new ImportError(SUBSCRIBERS_ONLY)
  if ([401, 403, 429].includes(response.status)) throw new ImportError(BROWSERS_ONLY)
  throw new ImportError(`The site answered ${response.status}`)
}

/** The file itself, where a site shows a file in a page of its own. */
function fileBehind(url: string): string | null {
  const github = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/([^?#]+\.\w+)$/.exec(url)
  if (github) return `https://github.com/${github[1]}/raw/${github[2]}`
  const google = /^https:\/\/docs\.google\.com\/(document|presentation|spreadsheets)\/d\/([\w-]{20,})/.exec(url)
  const as = { document: "docx", presentation: "pptx", spreadsheets: "xlsx" }
  if (google) return `https://docs.google.com/${google[1]}/d/${google[2]}/export?format=${as[google[1] as keyof typeof as]}`
  const drive = /^https:\/\/drive\.google\.com\/file\/d\/([\w-]{20,})/.exec(url)?.[1]
  if (drive) return `https://drive.google.com/uc?export=download&id=${drive}`
  if (/^https:\/\/(?:www\.)?dropbox\.com\/(?:s|scl\/fi)\//.test(url)) {
    const download = new URL(url)
    download.searchParams.set("dl", "1")
    return download.href
  }
  return null
}

/** What a link answered: a feed's items, or else the source of the article
 *  in it, named as the site names it. */
async function read(response: Response, base: string): Promise<Fetched> {
  const disposition = response.headers.get("content-disposition") ?? ""
  let name =
    /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1] ??
    /filename="?([^";]+)/i.exec(disposition)?.[1] ??
    (new URL(response.url || base).pathname.split("/").pop() || "document")
  try {
    name = decodeURIComponent(name)
  } catch {}
  const type = response.headers.get("content-type") ?? ""
  const bytes = await download(response)
  const feed = /xml|json/.test(type) && !/html/.test(type) ? parseFeed(decode(bytes, type), base) : null
  if (feed) {
    if (!feed.length) throw new ImportError("That feed lists no links")
    return { feed }
  }
  const refused = /html/.test(type) && withheld(decode(bytes, type))
  if (refused) throw new ImportError(refused)
  return { source: { bytes, name, type, url: base } }
}

/** Why a page a site answered with holds no article to keep, if it doesn't: it
 *  checks for a browser, or the article is cut short for anyone not subscribed.
 *  A site that sells its articles tells search engines so, naming any part of
 *  the page that holds the rest, sent all the same for them to read, and
 *  maybe how many words it is, which a preview falls short of. */
function withheld(html: string): string | null {
  const title = /<title[^>]*>([^<]*)/i.exec(html)?.[1].trim() ?? ""
  if (/^(?:just a moment|attention required|client challenge|access denied|are you a robot|robot or human|verifying you are human|security check)\b/i.test(title)) {
    return BROWSERS_ONLY
  }
  const data = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].flatMap(([, json]) => {
    try {
      return [...objectsIn(JSON.parse(json))]
    } catch {
      return []
    }
  })
  if (!data.some((object) => String(object.isAccessibleForFree).toLowerCase() === "false")) return null
  const { document } = parseHTML(html)
  const parts = data.flatMap((object) => {
    try {
      return typeof object.cssSelector === "string" ? Array.from(document.querySelectorAll(object.cssSelector)) : []
    } catch {
      return []
    }
  })
  // Said in its data for search engines, or in its own for its pages' scripts.
  const declared = Math.max(0, ...Array.from(html.matchAll(/"wordCount"\s*:\s*"?(\d+)/g), ([, count]) => Number(count)))
  if (!parts.length && !declared) return SUBSCRIBERS_ONLY
  // A site that names no part may send the whole article all the same, counting
  // its views in the browser: its paragraphs come to as many words as it says.
  const sent = (parts.length ? parts : Array.from(document.querySelectorAll("p")))
    .map((part) => part.textContent!).join(" ").split(/\s+/).filter(Boolean).length
  return sent < declared * 0.7 ? SUBSCRIBERS_ONLY : null
}

/** Every object in a value parsed from JSON, however deep. */
function* objectsIn(value: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) for (const item of value) yield* objectsIn(item)
  else if (value && typeof value === "object") {
    yield value as Record<string, unknown>
    for (const child of Object.values(value)) yield* objectsIn(child)
  }
}

/** As many of the web's pictures as an article keeps. */
const MAX_PICTURES = 100

/** The pictures an article shows from the web, in its Markdown and as the
 *  cover on its card, each pointed at the copy kept with it, found by where
 *  it came from. As the article is saved, page names the rest of the pictures
 *  its page has, and each not kept yet is downloaded now, for this reading and
 *  any after: reading it again downloads none, so it shows what was there
 *  when it was saved. One that can't be kept stays on the web, as do any past
 *  MAX_PICTURES or MAX_BYTES of them. An article whose cover can't be kept, or
 *  that names none, takes its first picture kept as its cover, so its card
 *  shows a picture of its own. */
export async function keepImages(markdown: string, cover: string | null, kept: Map<string, string>, page: string[] | null):
  Promise<{ markdown: string; cover: string | null; images: EmbeddedImage[] }> {
  const onWeb = (url: string | null): url is string => !!url && /^https?:\/\//i.test(url)
  const shown = [...new Set(imagesOf(markdown).filter(onWeb))]
  const found = new Map(kept)
  const pictures = new Pictures()
  // The cover first, so the card keeps its picture whatever else is kept; then the article's, then the rest of its page's.
  const wanted = page ? [...new Set([cover, ...shown, ...page])] : []
  const missing = wanted.filter(onWeb).filter((url) => !found.has(url)).slice(0, MAX_PICTURES)
  let budget = MAX_BYTES
  for (let i = 0; i < missing.length && budget > 0; i += 6) {
    // Each of those downloaded at once may take its share of what is left, so together they never pass it.
    const batch = missing.slice(i, i + 6)
    await Promise.all(batch.map(async (url) => {
      const bytes = await picture(url, Math.floor(budget / batch.length))
      if (!bytes) return
      budget -= bytes.length
      const address = pictures.address(bytes, url)
      if (address) found.set(url, address.slice("/images/".length))
    }))
  }
  const local = (url: string | null) => {
    if (!url) return null
    // A picture the source holds is kept already, at this address.
    if (/^\/images\/[0-9a-f]{64}$/.test(url)) return url
    return found.has(url) ? `/images/${found.get(url)}` : null
  }
  for (const url of shown) {
    const address = local(url)
    if (address) markdown = markdown.replaceAll(`](${url})`, `](${address})`)
  }
  return { markdown, cover: local(cover) ?? imagesOf(markdown).map(local).find(Boolean) ?? cover, images: pictures.images }
}

/** A picture's bytes, if it sends them within the limit. */
async function picture(url: string, limit: number): Promise<Uint8Array | null> {
  const response = await fetch(url, { headers: { "user-agent": HEADERS["user-agent"], accept: "image/*" }, signal: AbortSignal.timeout(15_000) })
    .catch(() => null)
  return response?.ok ? readBytes(response, limit).catch(() => null) : null
}

/** What a response sends, or why it can't be kept. */
async function download(response: Response): Promise<Uint8Array> {
  try {
    return await readBytes(response)
  } catch (error) {
    throw new ImportError(error instanceof SizeLimit ? "That is too large to save (1 GB maximum)" : "The site stopped before sending all of it")
  }
}

/** What a site's API answered, kept as it came; or, if it gave no article,
 *  why, as refused says, or else with the status it answered. */
async function fetchApi(site: string, url: string, refused?: string): Promise<{ source: Source }> {
  const response = await get(url)
  if (!response?.ok) throw new ImportError(response ? refused ?? `${site} answered ${response.status}` : `Couldn't reach ${site}`)
  return { source: { bytes: await download(response), name: "", type: response.headers.get("content-type") ?? "", url } }
}

/** The article in what a site's API answered, if the source is that. */
export function siteArticle({ bytes, type, url }: Source): ExtractedArticle | null {
  if (!url) return null
  const answer = () => decode(bytes, type)
  if (url.startsWith(STORY)) return readStory(JSON.parse(answer()))
  if (PATCH.test(url)) return readCommit(answer(), url.slice(0, -".patch".length))
  if (url.startsWith(THREAD)) return readSkeet(JSON.parse(answer()))
  if (url.startsWith(POST)) return readPost(JSON.parse(answer()))
  if (url.startsWith(VIDEO)) return readVideo(JSON.parse(answer()), new URL(url).searchParams.get("url")!)
  return null
}

/** A story on Hacker News: the page it links to, or, posted to Hacker News
 *  itself, such as an Ask HN, what the API answered. */
async function fetchStory(id: string): Promise<Fetched> {
  const none = "Hacker News has no story by that number"
  const { source } = await fetchApi("Hacker News", `${STORY}${id}.json`, none)
  const item: { title?: string; url?: string } | null = JSON.parse(decode(source.bytes, source.type))
  if (!item?.title) throw new ImportError(none)
  return item.url ? fetchLink(item.url) : { source }
}

/** A story of Hacker News' own: its text, which the API gives as HTML. */
function readStory(item: { title: string; by?: string; time?: number; text?: string }): ExtractedArticle {
  return {
    title: item.title,
    site: "Hacker News",
    byline: item.by,
    publishedAt: item.time ? new Date(item.time * 1000) : null,
    html: item.text ?? "",
  }
}

/** A commit as its patch tells it, an email: the subject, the message, then
 *  after a line of "---" the files changed and the diff. GitHub shows a
 *  commit's message as plain text, and so does this. */
function readCommit(patch: string, url: string): ExtractedArticle {
  const headers = patch.slice(0, patch.indexOf("\n\n"))
  const subject = /^Subject: (?:\[PATCH[^\]]*\] )?(.*(?:\n .*)*)/m.exec(headers)?.[1].replace(/\n /g, " ") ?? url
  const rest = patch.slice(headers.length + 2)
  const start = rest.search(/^diff /m)
  const diff = start < 0 ? "" : rest.slice(start).replace(/\n-- \n[\s\S]*$/, "").trimEnd()
  const date = new Date(/^Date: (.*)$/m.exec(headers)?.[1] ?? "")
  return {
    title: subject,
    site: "GitHub",
    byline: /^From: (.*?)(?: <.*>)?$/m.exec(headers)?.[1],
    publishedAt: Number.isNaN(date.getTime()) ? null : date,
    html: paragraphsOf(rest.split(/^---$/m)[0]) + (diff && `<pre><code class="language-diff">${escapeHtml(diff)}</code></pre>`),
  }
}

/** A post's opening words, as the title of an article that has none. */
const opening = (text: string) => {
  const line = text.trim().split("\n")[0]
  const space = line.lastIndexOf(" ", 100)
  return line.length > 100 ? `${line.slice(0, space > 50 ? space : 100)}…` : line
}

type Skeet = {
  author: { did: string; handle: string; displayName?: string; avatar?: string }
  record: { text: string; createdAt: string; facets?: { index: { byteStart: number; byteEnd: number }; features: { uri?: string; did?: string }[] }[] }
  embed?: Embed
}
type Embed = {
  images?: { fullsize: string; alt: string }[]
  external?: { uri: string; title: string }
  record?: { author?: Skeet["author"]; value?: Skeet["record"]; record?: Embed["record"] }
  media?: Embed
  thumbnail?: string
}
type Thread = { post?: Skeet; replies?: Thread[] }

/** A post on Bluesky, and the posts its author threaded under it, from
 *  Bluesky's public API, which needs no account. */
function readSkeet({ thread }: { thread: Thread }): ExtractedArticle {
  const posts: Skeet[] = []
  for (let at: Thread | undefined = thread; at?.post; at = at.replies?.find((reply) => reply.post?.author.did === thread.post!.author.did)) {
    posts.push(at.post)
  }
  if (!posts.length) throw new ImportError("Bluesky has no post at that link")
  const { author, record, embed } = posts[0]
  return {
    title: opening(record.text) || `${author.displayName || author.handle} on Bluesky`,
    site: "Bluesky",
    byline: `${author.displayName || author.handle} (@${author.handle})`,
    image: embed?.images?.[0]?.fullsize ?? embed?.media?.images?.[0]?.fullsize ?? author.avatar ?? null,
    publishedAt: new Date(record.createdAt),
    html: posts.map((post) => richText(post.record) + embedded(post.embed)).join(""),
  }
}

/** A post's text, its links where its facets say they are, counted in bytes of UTF-8. */
function richText({ text, facets = [] }: Skeet["record"]): string {
  const bytes = Buffer.from(text)
  let html = ""
  let at = 0
  for (const { index, features } of facets.toSorted((a, b) => a.index.byteStart - b.index.byteStart)) {
    const href = features[0]?.uri ?? (features[0]?.did && `https://bsky.app/profile/${features[0].did}`)
    if (!href || index.byteStart < at) continue
    html += escapeHtml(bytes.subarray(at, index.byteStart).toString())
    html += `<a href="${escapeHtml(href)}">${escapeHtml(bytes.subarray(index.byteStart, index.byteEnd).toString())}</a>`
    at = index.byteEnd
  }
  html += escapeHtml(bytes.subarray(at).toString())
  return html.split(/\n{2,}/).map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br>")}</p>`).join("")
}

/** What a post holds besides its text: pictures, a link, the post it quotes. */
function embedded(embed: Embed | undefined): string {
  if (!embed) return ""
  const quoted = embed.record?.record ?? embed.record
  return [
    ...(embed.images ?? []).map((image) => `<p><img src="${escapeHtml(image.fullsize)}" alt="${escapeHtml(image.alt)}"></p>`),
    embed.thumbnail ? `<p><img src="${escapeHtml(embed.thumbnail)}" alt="Video"></p>` : "",
    embed.external ? `<p><a href="${escapeHtml(embed.external.uri)}">${escapeHtml(embed.external.title || embed.external.uri)}</a></p>` : "",
    quoted?.value ? `<blockquote>${richText(quoted.value)}<p>— ${escapeHtml(quoted.author?.displayName || quoted.author?.handle || "")}</p></blockquote>` : "",
    embedded(embed.media),
  ].join("")
}

/** A post on X, as X's oEmbed gives it: one post, its long ones cut short. */
function readPost(post: { author_name: string; author_url: string; html: string }): ExtractedArticle {
  const quote = parseHTML(post.html).document.querySelector("blockquote")
  const paragraphs = Array.from(quote?.querySelectorAll("p") ?? [], (p) => p.outerHTML).join("")
  // The post's date is the link it ends with.
  const date = new Date(Array.from(quote?.children ?? []).filter((child) => child.tagName === "A").at(-1)?.textContent ?? "")
  const handle = post.author_url.split("/").pop()
  return {
    title: opening(quote?.querySelector("p")?.textContent ?? "") || `${post.author_name} on X`,
    site: "X",
    byline: `${post.author_name} (@${handle})`,
    publishedAt: Number.isNaN(date.getTime()) ? null : date,
    html: paragraphs,
  }
}

/** A video on YouTube, as its oEmbed gives it: its title, channel and picture. */
function readVideo(video: { title: string; author_name: string; thumbnail_url: string }, url: string): ExtractedArticle {
  return {
    title: video.title,
    site: "YouTube",
    byline: video.author_name,
    image: video.thumbnail_url,
    html: `<p><a href="${escapeHtml(url)}"><img src="${escapeHtml(video.thumbnail_url)}" alt="${escapeHtml(video.title)}"></a></p>`,
  }
}
