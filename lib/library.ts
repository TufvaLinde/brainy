/**
 * Saving articles, and reading them. Each is kept whole the moment it comes:
 * its source, the file or page as it came, and on its first reading, every
 * picture it names on the web; and read from them again whenever the rules
 * that read articles change, so a better reader reaches every article, as it
 * was when it was saved. Reading again never goes to the web. Persistence
 * lives in db.
 */
import { once } from "node:events"
import { Worker } from "node:worker_threads"
import * as db from "@/lib/db"
import { restoreLibrary } from "@/lib/archive"
import { extract, isRecording } from "@/lib/formats"
import { ImportError } from "@/lib/files"
import { HighlightConflict } from "@/lib/highlights"
import { parseLinkList, type ArticleLink } from "@/lib/links"
import { render, toMarkdown, wordCount } from "@/lib/markdown"
import { removeUpload, takeUpload } from "@/lib/storage"
import { fetchLink, keepImages, siteArticle } from "@/lib/web"

/** Which rules read articles: lib/formats, the converters it calls, the
 *  sites' readers in lib/web, lib/markdown, and the pictures lib/web points
 *  at. Raise it with any change to what they make of a source, or to render,
 *  which the text highlights quote is read from, and every article is read
 *  again from its source. Upgrading a library that reads or writes articles
 *  is such a change, so package.json pins them. */
const CONVERTER = 12

const READERS = 6
export const isLink = (text: string) => /^https?:\/\//i.test(text) && URL.canParse(text)

const linksToSave = (links: ArticleLink[]): db.SavedLink[] =>
  [...new Map(links.map(link => [link.url, link])).values()]
    .map(link => ({ url: link.url, title: link.title || link.url, site: new URL(link.url).hostname }))

export async function addLinks(links: ArticleLink[]): Promise<void> { await db.addLinks(linksToSave(links)) }

let working: Promise<void> | undefined
/** Read what is waiting: feeds not read for an hour, links saved but not yet
 *  fetched, and sources not yet read by these rules. Requests share a drain;
 *  database leases coordinate separate server processes. */
export function processPending(): Promise<void> {
  return working ??= drain().finally(() => { working = undefined })
}
async function drain(): Promise<void> {
  await Promise.all((await db.claimFeeds()).map(async (url) => {
    try {
      const found = await fetchLink(url)
      if ("feed" in found) await db.readFeed(url, linksToSave(found.feed))
    } catch (error) {
      // Read again within the hour, as every feed is.
      console.error(`Reading the feed ${url} failed:`, error instanceof Error ? error.message : error)
    }
  }))
  for (;;) {
    const claims = await db.claimWork(CONVERTER, READERS)
    if (!claims.length) return
    await Promise.all(claims.map(work))
  }
}

/** Fetch a link and read it, or read a kept source; why it couldn't be, if it
 *  couldn't. The database or the bucket failing is no such reason: that
 *  throws, and the article is read again once its claim lapses. */
async function work(claim: db.Claim): Promise<string | null> {
  const kept = await db.imagesKept(claim.id)
  let fetched: db.Source | undefined
  let keeping = false
  try {
    let source = claim.source
    if (!source) {
      const found = await fetchLink(claim.url)
      if ("feed" in found) {
        keeping = true
        await db.finishWork(claim, { feed: linksToSave(found.feed) })
        return null
      }
      source = fetched = found.source
    }
    const reading = await inThread(source, kept, claim.capture)
    keeping = true
    await db.finishWork(claim, { reading, source: fetched })
    return null
  } catch (error) {
    if (keeping && !(error instanceof HighlightConflict)) throw error
    const expected = error instanceof ImportError || error instanceof HighlightConflict
    if (!expected) console.error(`Reading ${claim.url} failed:`, error)
    const reason = expected ? error.message : "Something went wrong reading that page"
    await db.finishWork(claim, { error: reason, source: fetched })
    return reason
  }
}

/** Threads that read articles (see lib/reading), each kept a minute for the next. */
const idle = new Map<Worker, NodeJS.Timeout>()

function startThread(): Worker {
  const thread = new Worker(new URL("./reading.ts", import.meta.url))
  // One that fails between articles is let go, not handed the next.
  return thread.on("error", () => {}).on("exit", () => idle.delete(thread))
}

/** A source read in a thread of its own: reading a book-length page takes the
 *  CPU for seconds, and the server would answer no one meanwhile. One that
 *  runs out of memory stops alone, and says so. */
async function inThread(source: db.Source, kept: Map<string, string>, capture: boolean): Promise<db.Reading> {
  const [thread, timer] = idle.entries().next().value ?? [startThread()]
  clearTimeout(timer)
  idle.delete(thread)
  thread.postMessage({ source, kept, capture })
  const [answer] = await once(thread, "message").catch(async (error) => {
    await thread.terminate()
    throw error.code === "ERR_WORKER_OUT_OF_MEMORY" ? new ImportError("That is more than the server has the memory to read: its file is kept") : error
  })
  idle.set(thread, setTimeout(() => idle.delete(thread) && thread.terminate(), 60_000).unref())
  if ("reading" in answer) return answer.reading
  throw answer.expected ? new ImportError(answer.error.message) : answer.error
}

/** A source read by these rules, its pictures on the web pointed at those
 *  kept before, or saved with it, by where they came from; or, as it is
 *  captured, at those it and its page name, downloaded now. */
export async function read(source: db.Source, kept: Map<string, string>, capture: boolean): Promise<db.Reading> {
  const { images = [], original = null, pictures = [], ...article } = siteArticle(source) ?? (await extract(source))
  const written = "html" in article ? toMarkdown(article.html, article.title) : article.markdown.trim()
  if (!written && !original) throw new ImportError("No article found: if the page shows one, save it with the bookmarklet")
  const had = new Map([...kept, ...images.flatMap((image) => (image.url ? [[image.url, image.hash] as const] : []))])
  const { markdown, cover, images: downloaded } = await keepImages(written, article.image ?? null, had, capture ? pictures : null)
  const { html, text } = render(markdown)
  const { title, site, byline, publishedAt, excerpt } = article
  return {
    title, site, byline, image: cover, publishedAt, excerpt, markdown, html, text,
    words: wordCount(text), convertedWith: CONVERTER, images: [...images, ...downloaded], original,
  }
}

/** A page as the reader's own browser has it, sent by the bookmarklet. */
export async function savePage(url: string, html: string): Promise<number> {
  const source = { bytes: new TextEncoder().encode(html), name: "", type: "text/html; charset=utf-8", url }
  return saveSource(url, { title: url, site: new URL(url).hostname }, source)
}

/** A file the browser uploaded to the bucket (see lib/storage): a library's
 *  archive, of any size, whose articles are restored; the links it lists,
 *  saved to be read; or else its article. An archive is told first, as a
 *  source in it could be a list of links. Any other too large to read whole
 *  must be a recording, which is kept as it is, never read whole. */
export async function saveFile(upload: string, name: string, type: string): Promise<number | null> {
  let discard = true
  try {
    const { bytes, whole, upload: uploaded } = await takeUpload(upload)
    if (await restoreLibrary(upload, bytes)) return null
    if (!whole && !isRecording(bytes)) throw new ImportError("That file is over 1 GB: only a recording can be larger")
    if (!bytes.length) throw new ImportError("That file is empty")
    const links = parseLinkList(bytes, name, type)
    if (links) {
      if (!links.length) throw new ImportError("That file lists no links")
      await addLinks(links)
      return null
    }
    const about = { title: name.replace(/\.\w+$/, "") || name, site: name }
    return await saveSource(`file:${uploaded.hash}`, about, { bytes, name, type, url: null, upload: uploaded })
  } catch (error) {
    // A temporary failure in the bucket or database must leave the upload
    // available for another attempt. Invalid files and completed saves are done.
    discard = error instanceof ImportError
    throw error
  } finally {
    if (discard) await removeUpload(upload)
  }
}

/** A source the reader sent, in the library from the moment it is kept, and
 *  read at once; if it can't be, it stays, with why, to be read again when
 *  the rules change, and the reader is told. */
async function saveSource(url: string, about: { title: string; site: string }, source: db.Source): Promise<number> {
  const claim = await db.addSource(url, about, source, CONVERTER)
  const failed = await work(claim)
  if (failed) throw new ImportError(failed)
  return claim.id
}
