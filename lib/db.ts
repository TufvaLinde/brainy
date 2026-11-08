/** Brainy's persistence: what it knows of each article, in PostgreSQL,
 *  with its connections, schema and atomic changes; each article's files, in
 *  the bucket (see lib/storage), each put there before the database names it,
 *  so it never names one that isn't kept; and the shapes of what it stores,
 *  which the rest of the app shares. */
import { createHash } from "node:crypto"
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg"
import { anchor, HighlightConflict, quoteOf, validateNote, validateQuote, type Highlight, type Quote } from "@/lib/highlights"
import { WORDS_PER_MINUTE } from "@/lib/markdown"
import * as storage from "@/lib/storage"

export type Location = "inbox" | "feed" | "later" | "archive" | "trash"
export const LOCATIONS: Location[] = ["inbox", "feed", "later", "archive", "trash"]
/** What an article is read from, as it came: a file, a page, or what a site's
 *  API gave; url is the web address it came from, which its links are relative
 *  to. A file the browser uploaded is kept by a copy of its upload; one too
 *  large to read whole has only its first bytes here (see lib/storage). */
export type Source = { bytes: Uint8Array; name: string; type: string; url: string | null; upload?: storage.Upload }
/** A picture kept with an article; url is where it was downloaded from, if it was. */
export type EmbeddedImage = { hash: string; bytes: Uint8Array; url?: string }
export type OriginalFile = { name: string; type: string; hash: string }

export type ArticleMetadata = {
  title: string; site: string
  byline?: string | null; image?: string | null; publishedAt?: Date | null; excerpt?: string | null
}
/** A source read by the rules of one version: the article, as Markdown and as
 *  the reading view shows it, its pictures, and, for a source worth opening as
 *  it came, as a PDF is, its format and type. */
export type Reading = ArticleMetadata & {
  markdown: string; html: string; text: string; words: number; convertedWith: number
  images: EmbeddedImage[]; original: { format: string; type: string } | null
}
export type ArticleSummary = {
  id: number; url: string; title: string; site: string; image: string | null; excerpt: string | null
  format: string | null; location: Location; progress: number; minutesLeft: number; waiting: boolean; error: string | null
}
export type Article = ArticleSummary & {
  byline: string | null; publishedAt: Date | null
  /** Its reading, as getArticle was asked for it, once it has one. */
  reading: string | null
  /** The type its source is served as: a recording's says it plays. */
  type: string | null
  minutes: number; listenedTo: number | null; highlights: Highlight[]
  /** The user's note on the whole article, or "". */
  note: string
}

export type SavedLink = { url: string; title: string; site: string }
/** An article taken up to read by one version's rules: a link to fetch, or a
 *  source kept. capture says reading it keeps the pictures it names on the
 *  web, as only a source's first reading to come to anything does. */
export type Claim = { id: number; url: string; since: Date; rules: number; capture: boolean; source: Source | null }
/** An article as it is kept, but for the bytes of its source and pictures: what an archive holds (see lib/archive). */
export type KeptArticle = ArticleMetadata & {
  url: string; location: Location; movedAt: Date; progress: number; progressUpdatedAt: number; listenedTo: number | null
  markdown: string | null; convertedWith: number | null; error: string | null; note: string | null
  source: { name: string; type: string; url: string | null; format: string | null; hash: string } | null
  images: { hash: string; url: string | null }[]
  highlights: (Quote & { note: string; createdAt: Date })[]
}

type Run = <T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]) => Promise<QueryResult<T>>
type Database = { pool: Pool; ready?: Promise<void> }
const shared = globalThis as typeof globalThis & { brainyDatabase?: Database }

function pool(url: string): Pool {
  const ca = process.env.DATABASE_CA ?? process.env.POSTGRES_CA
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new Error("Invalid PostgreSQL connection URL") }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("Invalid PostgreSQL connection URL")
  // URL SSL settings override pg's ssl object. A custom CA must survive sslmode=require.
  if (ca && parsed.searchParams.get("sslmode") !== "disable" && parsed.searchParams.get("ssl") !== "0") {
    if (["sslcert", "sslkey", "sslrootcert"].some(key => parsed.searchParams.has(key))) {
      throw new Error("Configure certificates with DATABASE_CA or URL certificate options, not both")
    }
    parsed.searchParams.delete("sslmode")
    parsed.searchParams.delete("ssl")
  }
  // The library's background work and the next page can query at the same time.
  // Retain both connections instead of paying for a new TLS login after a pause.
  const client = new Pool({ connectionString: parsed.toString(), ssl: { ca }, min: 2, max: 5,
    connectionTimeoutMillis: 10_000, idleTimeoutMillis: 60_000 })
  client.on("error", error => console.error("An idle database connection failed:", error.message))
  return client
}

function database(): Database {
  if (shared.brainyDatabase) return shared.brainyDatabase
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL
  if (!url) throw new Error("Set DATABASE_URL to a PostgreSQL connection URL")
  return shared.brainyDatabase = { pool: pool(url) }
}

async function atomic<T>(connection: Pool, work: (run: Run) => Promise<T>): Promise<T> {
  const client: PoolClient = await connection.connect()
  let discard = false
  try {
    await client.query("begin")
    const result = await work((sql, values) => client.query(sql, values))
    await client.query("commit")
    return result
  } catch (error) {
    await client.query("rollback").catch(() => { discard = true })
    throw error
  } finally { client.release(discard) }
}

/** The schema, made in a database that has none, and marked with the hash of
 *  SCHEMA. There are no upgrades: a schema made by any other SCHEMA is refused,
 *  to be dropped and made afresh. Concurrent processes take turns. */
async function ready(): Promise<void> {
  const db = database()
  const version = "select obj_description(oid, 'pg_namespace') as version from pg_namespace where nspname = 'brainy'"
  const check = (made: { version: string | null }) => {
    if (made.version !== VERSION) throw new Error("The database's brainy schema was made by another version of brainy: drop it to start afresh")
  }
  return db.ready ??= (async () => {
    // Open the retained pair together; otherwise the first navigation races
    // the library's background query and pays for a second connection then.
    await Promise.all(Array.from({ length: 2 }, async () => {
      const connection = await db.pool.connect()
      connection.release()
    }))
    const { rows: [made] } = await db.pool.query<{ version: string | null }>(version)
    if (made) return check(made)
    await atomic(db.pool, async run => {
      await run("select pg_advisory_xact_lock(hashtext('brainy/schema'))")
      // Another process may have created it while this one waited for the lock.
      const { rows: [made] } = await run<{ version: string | null }>(version)
      if (made) check(made)
      else await run(`create schema brainy; comment on schema brainy is '${VERSION}'; ${SCHEMA}`)
    })
  })().catch(error => { db.ready = undefined; throw error })
}

const query: Run = async (sql, values) => { await ready(); return database().pool.query(sql, values) }
const transaction = async <T>(work: (run: Run) => Promise<T>) => { await ready(); return atomic(database().pool, work) }

const minutes = (words: string) => `greatest(1, round(${words} / ${WORDS_PER_MINUTE}.0))::int`
const LISTED = `id, url, title, site, image, excerpt, location, progress, format,
  ${minutes("words * (1 - progress)")} as "minutesLeft", markdown_hash is null and error is null as waiting, error`

/** Links to read, each moved to the inbox; or, as a feed lists them, only
 *  those not saved before, put in listedIn, so reading it again brings back
 *  none archived or trashed. */
async function insertLinks(run: Run, links: SavedLink[], listedIn?: Location): Promise<void> {
  if (!links.length) return
  await run(`insert into brainy.articles (url, title, site, location, moved_at)
    select url, title, site, $4, now() - n * interval '1 millisecond'
    from unnest($1::text[], $2::text[], $3::text[]) with ordinality as link(url, title, site, n)
    on conflict (url) do ${listedIn ? "nothing" : `update set location = 'inbox', moved_at = excluded.moved_at, error = null,
      source_hash = case when articles.markdown_hash is null then null else articles.source_hash end`}`,
  [links.map(l => l.url), links.map(l => l.title), links.map(l => l.site), listedIn ?? "inbox"])
}

/** A feed subscribed to, or read again: the items it lists that it didn't
 *  last time go to the Feed, so none archived, trashed or deleted since comes
 *  back. */
async function keepFeed(run: Run, url: string, links: SavedLink[]): Promise<void> {
  const { rows: [feed] } = await run<{ listed: string[] }>("select listed from brainy.feeds where url = $1 for update", [url])
  const listed = new Set(feed?.listed)
  await insertLinks(run, links.filter(link => !listed.has(link.url)), "feed")
  await run(`insert into brainy.feeds (url, listed, checked_at) values ($1, $2, now())
    on conflict (url) do update set listed = excluded.listed, checked_at = excluded.checked_at`, [url, links.map(link => link.url)])
}

/** The feeds not read for an hour, each marked read now, so no other request reads it too. */
export async function claimFeeds(): Promise<string[]> {
  const { rows } = await query<{ url: string }>(`update brainy.feeds set checked_at = now() where url in (
    select url from brainy.feeds where checked_at is null or checked_at < now() - interval '1 hour' for update skip locked)
    returning url`)
  return rows.map(row => row.url)
}
export async function readFeed(url: string, links: SavedLink[]): Promise<void> { await transaction(run => keepFeed(run, url, links)) }

/** The feeds subscribed to, with the items each listed last time. */
export async function listFeeds(): Promise<{ url: string; listed: string[] }[]> {
  const { rows } = await query<{ url: string; listed: string[] }>("select url, listed from brainy.feeds order by url")
  return rows
}
/** Feeds subscribed to before, as an archive holds them, but those subscribed to already. */
export async function restoreFeeds(feeds: { url: string; listed: string[] }[]): Promise<void> {
  await query(`insert into brainy.feeds (url, listed)
    select url, array(select json_array_elements_text(listed)) from json_to_recordset($1) as feed(url text, listed json)
    on conflict do nothing`, [JSON.stringify(feeds)])
}
/** A feed no longer read; what it brought stays. */
export async function unsubscribe(url: string): Promise<void> {
  await query("delete from brainy.feeds where url = $1", [url])
}

/** Links saved to be read, each moved to the inbox; one never read is fetched again. */
export async function addLinks(links: SavedLink[]): Promise<void> { await insertLinks(query, links) }

/** Claim articles to read by these rules, but none in the trash: links not yet
 *  fetched, and sources only older rules have read, so a server still running
 *  older ones during a deploy never undoes a newer one's reading. Each claim
 *  is a lease, which a stale worker no longer holds. */
export async function claimWork(rules: number, limit: number): Promise<Claim[]> {
  const { rows } = await query<{ id: number; url: string; since: Date; capture: boolean; hash: string | null; name: string; type: string; sourceUrl: string | null }>(
    `update brainy.articles set reading_since = date_trunc('milliseconds', clock_timestamp())
    where id in (
      select id from brainy.articles
      where location <> 'trash'
        and (source_hash is null and error is null and url ~ '^https?://' or source_hash is not null and coalesce(tried_with, 0) < $1)
        and (reading_since is null or reading_since < now() - interval '5 minutes')
      order by moved_at desc limit $2 for update skip locked)
    returning id, url, reading_since as since, tried_with is null or markdown_hash is null as capture,
      source_hash as hash, source_name as name, source_type as type, source_url as "sourceUrl"`,
    [rules, limit])
  return Promise.all(rows.map(async ({ hash, name, type, sourceUrl, ...claim }) =>
    ({ ...claim, rules, source: hash ? { bytes: await storage.get(claim.id, hash), name, type, url: sourceUrl } : null })))
}

/** A source the user sent, kept with its article, new or saved before,
 *  which moves to the inbox; and taken up to be read now. Its bytes go to the
 *  bucket while the transaction holds the article, so it is in the library
 *  from that moment, whatever reading it comes to, or else not at all. */
export async function addSource(url: string, about: { title: string; site: string }, source: Source, rules: number): Promise<Claim> {
  return transaction(async run => {
    const { rows: [{ id }] } = await run<{ id: number }>(`insert into brainy.articles (url, title, site) values ($1, $2, $3)
      on conflict (url) do update set location = 'inbox', moved_at = now() returning id`, [url, about.title, about.site])
    const kept = await putSource(id, source)
    const { rows: [{ since }] } = await run<{ since: Date }>(`update brainy.articles
      set source_hash = $2, source_name = $3, source_type = $4, source_url = $5,
        tried_with = null, reading_since = date_trunc('milliseconds', clock_timestamp()) where id = $1 returning reading_since as since`,
    [id, kept.hash, kept.name, kept.type, kept.url])
    return { id, url, since, rules, capture: true, source }
  })
}

/** What reading a claimed article came to, kept while the claim holds and the
 *  article is out of the trash: a feed's items, the feed subscribed to,
 *  taking the article's place; its reading; or why it couldn't be read, which
 *  an article read before keeps to itself, as it keeps its reading. A source
 *  fetched for it is kept either way. */
export async function finishWork(claim: Claim, outcome:
  | { feed: SavedLink[] }
  | { reading: Reading; source?: Source }
  | { error: string; source?: Source }): Promise<void> {
  const source = "source" in outcome && outcome.source ? await putSource(claim.id, outcome.source) : undefined
  const reading = "reading" in outcome ? await putReading(claim.id, outcome.reading, source?.hash) : undefined
  await transaction(async run => {
    const { rowCount } = await run("select from brainy.articles where id = $1 and reading_since = $2 and location <> 'trash' for update",
      [claim.id, claim.since])
    if (!rowCount) return
    if ("feed" in outcome) {
      await keepFeed(run, claim.url, outcome.feed)
      await run("delete from brainy.articles where id = $1", [claim.id])
    } else if ("error" in outcome) {
      await run(`update brainy.articles set error = case when markdown_hash is null then $2 end, tried_with = $3, reading_since = null
        where id = $1`, [claim.id, outcome.error, claim.rules])
      if (source) await keepSource(run, claim.id, source)
    } else if (reading) await keep(run, claim.id, reading, source)
  })
}

/** A source, or a reading, as the database keeps it: its bytes in the bucket, named by their hash. */
type KeptSource = Omit<Source, "bytes"> & { hash: string }
type KeptReading = Omit<Reading, "markdown" | "html" | "images"> & { markdownHash: string; htmlHash: string; images: { hash: string; url?: string }[] }

const putSource = async (id: number, { bytes, upload, ...source }: Source): Promise<KeptSource> =>
  ({ ...source, hash: await (upload ? storage.keepUpload(id, upload) : storage.put(id, bytes)) })

/** Pictures put in the bucket, each once, however many addresses it came from. */
const putPictures = (id: number, images: EmbeddedImage[]) =>
  [...new Map(images.map(image => [image.hash, image.bytes])).values()].map(bytes => storage.put(id, bytes))

/** Put only bytes this article does not already keep, including its source. */
async function putReading(id: number, { markdown, html, images, ...reading }: Reading, sourceHash?: string): Promise<KeptReading> {
  const { rows } = await query<{ hash: string | null }>(`select unnest(array[source_hash, markdown_hash, html_hash]) as hash
    from brainy.articles where id = $1 union all select hash from brainy.images where article_id = $1`, [id])
  const kept = new Set(rows.flatMap(({ hash }) => hash ? [hash] : []))
  if (sourceHash) kept.add(sourceHash)
  const [markdownHash, htmlHash] = await Promise.all([
    storage.put(id, new TextEncoder().encode(markdown), kept),
    storage.put(id, new TextEncoder().encode(html), kept),
    ...putPictures(id, images.filter(image => !kept.has(image.hash))),
  ])
  // Each named, a picture kept before too: it may have come from another address this time.
  return { ...reading, markdownHash, htmlHash, images: images.map(({ hash, url }) => ({ hash, url })) }
}

/** The pictures kept with an article that were downloaded, by where from. */
export async function imagesKept(id: number): Promise<Map<string, string>> {
  const { rows } = await query<{ url: string; hash: string }>("select url, hash from brainy.images where article_id = $1 and url is not null", [id])
  return new Map(rows.map(row => [row.url, row.hash]))
}

/** Each of an article's highlights placed in its new text, with the words
 *  around it there; false, changing none, if any can't be. Called only while
 *  the article row is locked, before its text changes. */
async function moveHighlights(run: Run, id: number, text: string): Promise<boolean> {
  const { rows } = await run<Quote & { id: number }>("select id, quote, prefix, suffix, position from brainy.highlights where article_id = $1", [id])
  const moved = []
  for (const highlight of rows) {
    const at = anchor(highlight, text)
    if (at === null) return false
    moved.push({ id: highlight.id, ...quoteOf(text, at, at + highlight.quote.length) })
  }
  if (moved.length) await run(`update brainy.highlights set prefix = place.prefix, suffix = place.suffix, position = place.position
    from unnest($1::int[], $2::text[], $3::text[], $4::int[]) as place(id, prefix, suffix, position) where highlights.id = place.id`,
  [moved.map(h => h.id), moved.map(h => h.prefix), moved.map(h => h.suffix), moved.map(h => h.position)])
  return true
}

/** A reading, and the source it was read from if that is new, in place of
 *  the article's last; the pictures it brings join those kept before, which
 *  stay as long as the article does. */
async function keep(run: Run, id: number, reading: KeptReading, source?: KeptSource): Promise<void> {
  if (!(await moveHighlights(run, id, reading.text))) throw new HighlightConflict()
  if (source) await keepSource(run, id, source)
  // The source is typed as it is served as an original, which reading it again goes by too.
  await run(`update brainy.articles set (title, byline, site, image, published_at, excerpt, markdown_hash, html_hash, text, words, format,
    converted_with, tried_with) = ($2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13), source_type = coalesce($14, source_type),
    error = null, reading_since = null, listened_to = case when markdown_hash = $8 then listened_to end where id = $1`,
  [id, reading.title, reading.byline, reading.site, reading.image, reading.publishedAt, reading.excerpt, reading.markdownHash,
    reading.htmlHash, reading.text, reading.words, reading.original?.format ?? null, reading.convertedWith, reading.original?.type ?? null])
  await keepPassages(run, id, reading.title, reading.text)
  const { images } = reading
  if (images.length) await run(`insert into brainy.images (article_id, hash, url)
    select $1, * from unnest($2::text[], $3::text[]) on conflict do nothing`,
  [id, images.map(i => i.hash), images.map(i => i.url ?? null)])
}

/** As many characters of an article as search indexes together: an index entry
 *  holds at most a megabyte of distinct words, and these can't come to more. */
const PASSAGE = 100_000

/** An article's words, its title's first, indexed for search a passage at a
 *  time, each cut where a word ends. */
async function keepPassages(run: Run, id: number, title: string, text: string): Promise<void> {
  const words = `${title} ${text}`
  const passages: string[] = []
  for (let at = 0; at < words.length;) {
    let end = at + PASSAGE
    if (end < words.length) {
      const space = words.lastIndexOf(" ", end)
      if (space > at) end = space
    }
    passages.push(words.slice(at, end))
    at = end
  }
  await run(`with removed as (delete from brainy.passages where article_id = $1)
    insert into brainy.passages (article_id, words) select $1, to_tsvector('english', p) from unnest($2::text[]) as p`, [id, passages])
}

async function keepSource(run: Run, id: number, source: KeptSource): Promise<void> {
  await run("update brainy.articles set source_hash = $2, source_name = $3, source_type = $4, source_url = $5 where id = $1",
    [id, source.hash, source.name, source.type, source.url])
}

/** A location's latest articles, at most limit of them; ties by id, so a longer list starts as the shorter one did. */
export async function listArticles(location: Location, limit: number): Promise<ArticleSummary[]> {
  const { rows } = await query<ArticleSummary>(`select ${LISTED} from brainy.articles where location = $1
    order by moved_at desc, id desc limit $2`, [location, limit])
  return rows
}

/** The articles that match, out of the trash, by their title and text, author, or a note on one or on a
 *  highlight, ranked by whichever matches best; at most limit of them. Authors and notes are short and
 *  few, so they are read as searched, needing no index of their own. */
export async function search(words: string, limit: number): Promise<ArticleSummary[]> {
  const { rows } = await query<ArticleSummary>(`with asked as (select websearch_to_tsquery('english', $1) as q),
    matches as (
      select article_id as id, ts_rank(words, q) as rank from brainy.passages, asked where words @@ q
      union all
      select id, ts_rank(to_tsvector('english', byline), q) from brainy.articles, asked where to_tsvector('english', byline) @@ q
      union all
      select id, ts_rank(to_tsvector('english', note), q) from brainy.articles, asked where to_tsvector('english', note) @@ q
      union all
      select article_id, ts_rank(to_tsvector('english', note), q) from brainy.highlights, asked where to_tsvector('english', note) @@ q
    )
    select ${LISTED} from brainy.articles join (select id, max(rank) as rank from matches group by id) as found using (id)
    where location <> 'trash' order by rank desc, id desc limit $2`, [words, limit])
  return rows
}

// Readings are immutable at their hashes. Keep a bounded amount of their text,
// while the article's metadata, highlights and current hash are still read fresh.
const TEXT_CACHE_BYTES = 32 * 1024 * 1024
const TEXT_ENTRY_BYTES = 16 * 1024 * 1024
const TEXT_CACHE_ENTRIES = 128
const texts = new Map<string, string>()
const readingText = new Map<string, Promise<string>>()
let textBytes = 0

async function textIn(id: number, hash: string | null, interactive = false): Promise<string | null> {
  if (hash === null) return null
  if (!interactive) return new TextDecoder().decode(await storage.get(id, hash))
  const key = `${id}/${hash}`
  const cached = texts.get(key)
  if (cached !== undefined) {
    texts.delete(key)
    texts.set(key, cached)
    return cached
  }
  let reading = readingText.get(key)
  if (!reading) {
    reading = (async () => {
      const bytes = await storage.get(id, hash, true)
      const text = new TextDecoder().decode(bytes)
      const size = text.length * 2
      // Only whole, verified objects enter the cache, never a large file's prefix.
      if (size <= TEXT_ENTRY_BYTES && createHash("sha256").update(bytes).digest("hex") === hash) {
        while ((textBytes + size > TEXT_CACHE_BYTES || texts.size >= TEXT_CACHE_ENTRIES) && texts.size) {
          const [oldest, value] = texts.entries().next().value!
          texts.delete(oldest)
          textBytes -= value.length * 2
        }
        texts.set(key, text)
        textBytes += size
      }
      return text
    })().finally(() => readingText.delete(key))
    readingText.set(key, reading)
  }
  return reading
}

/** An article, with its reading as the reading view shows it, or as Markdown. */
export async function getArticle(id: number, form: "html" | "markdown"): Promise<Article | null> {
  const { rows: [row] } = await query<Omit<Article, "reading"> & { hash: string | null }>(`select ${LISTED}, byline,
    published_at as "publishedAt", ${form}_hash as hash, source_type as type, ${minutes("words")} as minutes,
    listened_to as "listenedTo", coalesce(note, '') as note, (select coalesce(json_agg(h order by h.position), '[]') from (
      select id, quote, prefix, suffix, position, coalesce(note, '') as note from brainy.highlights where article_id = $1
    ) as h) as highlights from brainy.articles where id = $1`, [id])
  if (!row) return null
  const { hash, ...article } = row
  return { ...article, reading: await textIn(id, hash, true) }
}

export async function getImage(hash: string): Promise<Uint8Array | null> {
  const { rows: [image] } = await query<{ id: number }>("select article_id as id from brainy.images where hash = $1 limit 1", [hash])
  return image ? storage.get(image.id, hash) : null
}

/** The source of an article it is worth opening as it came, as a PDF is, or
 *  the file it was, read or not. */
export async function getOriginal(id: number): Promise<OriginalFile | null> {
  const { rows: [file] } = await query<OriginalFile>(`select source_name as name, source_type as type, source_hash as hash
    from brainy.articles where id = $1 and source_hash is not null and (format is not null or url like 'file:%')`, [id])
  return file ?? null
}

/** An article that couldn't be read, waiting to be read again: from its source, if one was kept, or else fetched. */
export async function retry(id: number): Promise<void> {
  await query("update brainy.articles set error = null, tried_with = null where id = $1 and error is not null", [id])
}
export async function moveArticles(ids: number[], location: Location): Promise<void> {
  await query("update brainy.articles set location = $2, moved_at = now() where id = any($1::int[])", [ids, location])
}
/** The only deletion: the trash's articles, with their highlights and pictures, then their files. */
export async function emptyTrash(): Promise<void> {
  const { rows } = await query<{ id: number }>("delete from brainy.articles where location = 'trash' returning id")
  await storage.removeArticles(rows.map(row => row.id))
}
export async function setProgress(id: number, progress: number, updatedAt: number): Promise<void> {
  await query(`update brainy.articles set progress = $2, progress_updated_at = $3 where id = $1 and progress_updated_at < $3`,
    [id, Math.min(1, Math.max(0, progress)), updatedAt])
}
export async function setListened(id: number, block: number): Promise<void> {
  if (!Number.isInteger(block) || block < 0) throw new Error("Invalid listening position")
  await query("update brainy.articles set listened_to = $2 where id = $1", [id, block])
}

export async function saveHighlight(articleId: number, quote: Quote): Promise<Highlight> {
  return transaction(async run => {
    const { rows: [article] } = await run<{ text: string }>("select text from brainy.articles where id = $1 for update", [articleId])
    validateQuote(quote, article?.text ?? "")
    // The same words at the same place are one highlight, however often it is asked for.
    const { rows: [kept] } = await run<Highlight>(`select id, quote, prefix, suffix, position, coalesce(note, '') as note
      from brainy.highlights where article_id = $1 and position = $2 and quote = $3`, [articleId, quote.position, quote.quote])
    if (kept) return kept
    const { rows } = await run<Highlight>(`insert into brainy.highlights (article_id, quote, prefix, suffix, position) values ($1, $2, $3, $4, $5)
      returning id, quote, prefix, suffix, position, '' as note`, [articleId, quote.quote, quote.prefix, quote.suffix, quote.position])
    return rows[0]
  })
}
/** Every article's id but the trash's, oldest first. */
export async function keptIds(): Promise<number[]> {
  const { rows } = await query<{ id: number }>("select id from brainy.articles where location <> 'trash' order by moved_at, id")
  return rows.map(row => row.id)
}

/** An article as it is kept, its Markdown among it, and its source, a part
 *  at a time, and the bytes of its pictures, which never change while it is
 *  kept; null if it is gone. */
export async function keptArticle(id: number): Promise<{
  article: KeptArticle; files: { source: AsyncIterable<Uint8Array> | null; images: { hash: string; bytes: Uint8Array }[] }
} | null> {
  const { rows: [row] } = await query<Omit<KeptArticle, "markdown"> & { markdownHash: string | null }>(`select
    url, title, site, byline, image, published_at as "publishedAt", excerpt, location, moved_at as "movedAt", progress,
    progress_updated_at::float8 as "progressUpdatedAt", listened_to as "listenedTo", markdown_hash as "markdownHash",
    converted_with as "convertedWith", error, note,
    case when source_hash is not null then json_build_object('name', source_name, 'type', source_type, 'url', source_url, 'format', format,
      'hash', source_hash) end as source,
    (select coalesce(json_agg(json_build_object('hash', hash, 'url', url) order by hash), '[]') from brainy.images i where i.article_id = a.id) as images,
    (select coalesce(json_agg(json_build_object('quote', quote, 'prefix', prefix, 'suffix', suffix, 'position', position,
      'note', coalesce(note, ''), 'createdAt', created_at) order by position), '[]') from brainy.highlights h where h.article_id = a.id) as highlights
    from brainy.articles a where id = $1`, [id])
  if (!row) return null
  const { markdownHash, ...article } = row
  const [markdown, source, images] = await Promise.all([
    textIn(id, markdownHash),
    article.source && storage.stream(id, article.source.hash),
    Promise.all([...new Set(article.images.map(image => image.hash))].map(async hash => ({ hash, bytes: await storage.get(id, hash) }))),
  ])
  return { article: { ...article, markdown }, files: { source, images } }
}

/** An article as it was kept, with the bytes of its pictures, its source,
 *  kept for its id by the function given, which answers with its hash, and
 *  its text as read now, unless one with its link is kept already. Its files
 *  go to the bucket while the transaction holds it back, so it comes whole or
 *  not at all. */
export async function restoreArticle(article: KeptArticle, keepSource: ((id: number) => Promise<string>) | null, images: EmbeddedImage[],
  { html, text, words }: { html: string; text: string; words: number }): Promise<boolean> {
  return transaction(async run => {
    const { rows: [row] } = await run<{ id: number }>(`insert into brainy.articles (url, title, site, byline, image, published_at, excerpt,
      location, moved_at, progress, progress_updated_at, listened_to, text, words, converted_with, tried_with, error,
      source_name, source_type, source_url, format, note)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15, $16, $17, $18, $19, $20, $21)
      on conflict (url) do nothing returning id`,
    [article.url, article.title, article.site, article.byline, article.image, article.publishedAt, article.excerpt,
      article.location, article.movedAt, article.progress, article.progressUpdatedAt, article.listenedTo,
      text, words, article.convertedWith, article.error, article.source?.name, article.source?.type, article.source?.url, article.source?.format,
      article.note ?? null])
    if (!row) return false
    const { markdown } = article
    const [markdownHash, htmlHash, sourceHash] = await Promise.all([
      markdown === null ? null : storage.put(row.id, new TextEncoder().encode(markdown)),
      markdown === null ? null : storage.put(row.id, new TextEncoder().encode(html)),
      keepSource?.(row.id) ?? null,
      ...putPictures(row.id, images),
    ])
    await run("update brainy.articles set markdown_hash = $2, html_hash = $3, source_hash = $4 where id = $1",
      [row.id, markdownHash, htmlHash, sourceHash])
    await keepPassages(run, row.id, article.title, text)
    if (images.length) await run(`insert into brainy.images (article_id, hash, url)
      select $1, * from unnest($2::text[], $3::text[])`,
    [row.id, images.map(i => i.hash), images.map(i => i.url ?? null)])
    const { highlights } = article
    if (highlights.length) await run(`insert into brainy.highlights (article_id, quote, prefix, suffix, position, note, created_at)
      select $1, quote, prefix, suffix, position, nullif(note, ''), created_at
      from unnest($2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::timestamptz[]) as h(quote, prefix, suffix, position, note, created_at)`,
    [row.id, highlights.map(h => h.quote), highlights.map(h => h.prefix), highlights.map(h => h.suffix),
      highlights.map(h => h.position), highlights.map(h => h.note), highlights.map(h => h.createdAt)])
    return true
  })
}

export async function setNote(id: number, note: string): Promise<void> {
  await query("update brainy.highlights set note = nullif($2, '') where id = $1", [id, validateNote(note)])
}
export async function setArticleNote(id: number, note: string): Promise<void> {
  await query("update brainy.articles set note = nullif($2, '') where id = $1", [id, validateNote(note)])
}
export async function removeHighlight(id: number): Promise<void> {
  await query("delete from brainy.highlights where id = $1", [id])
}

const SCHEMA = `
  create table brainy.articles (
    id integer generated always as identity primary key,
    url text not null unique, -- the link it was saved from, or for a file, file: and the hash of its bytes
    title text not null, byline text, site text not null,
    image text, published_at timestamptz, excerpt text,
    -- Its files are in the bucket, each at the hash of its bytes (see lib/storage).
    -- Its source, the file or page as it came, read again whenever the rules that read articles change.
    source_hash text, source_name text, source_type text,
    source_url text, -- where it was fetched from, which its links are relative to
    format text, -- the format of a source worth opening as it came, as a PDF is
    markdown_hash text, -- the article as Markdown, once read
    html_hash text, -- and as the reading view shows it
    text text not null default '', -- the article as plain text, which search and highlights read
    words integer not null default 0,
    converted_with integer, -- the version of the rules (see lib/library) that wrote it
    tried_with integer, -- the rules that last read it, though they kept the reading before
    error text, -- why it could not be read
    reading_since timestamptz, -- when a request took it up to read, which only that request's result may match
    location text not null default 'inbox' check (location in ('inbox', 'feed', 'later', 'archive', 'trash')),
    moved_at timestamptz not null default now(), -- when saved, or last moved
    progress real not null default 0, -- how far it has been read, 0 to 1
    progress_updated_at bigint not null default 0, -- when, by the user's browser, so an older position never replaces a newer one
    listened_to integer, -- the block the voice last reached
    note text -- the user's note on the whole article
  );
  create index articles_location on brainy.articles (location, moved_at desc);

  -- The article's words, a passage at a time (see keepPassages), as search finds them.
  create table brainy.passages (
    article_id integer not null references brainy.articles on delete cascade,
    words tsvector not null
  );
  create index passages_article on brainy.passages (article_id);
  create index passages_search on brainy.passages using gin (words);

  -- Every picture kept with an article: read out of its source, or downloaded as it was saved,
  -- once for each address it came from.
  create table brainy.images (
    article_id integer not null references brainy.articles on delete cascade,
    hash text not null, -- of its bytes, its address: /images/hash
    url text, -- where it was downloaded from, if it was
    unique nulls not distinct (article_id, hash, url)
  );
  create index images_by_hash on brainy.images (hash);

  -- A quote of the article's text, found by its words and the 32 characters either side (see lib/highlights).
  create table brainy.highlights (
    id integer generated always as identity primary key,
    article_id integer not null references brainy.articles on delete cascade,
    quote text not null, prefix text not null, suffix text not null, position integer not null,
    note text,
    created_at timestamptz not null default now()
  );
  create index highlights_article on brainy.highlights (article_id, position);

  -- A feed subscribed to, read again every hour (see claimFeeds).
  create table brainy.feeds (
    url text primary key,
    listed text[] not null default '{}', -- the items it listed when last read, so only new ones are added
    checked_at timestamptz -- when it was last read; null, never
  );
`
const VERSION = createHash("sha256").update(SCHEMA).digest("hex")
