/** The cloud half's memory, in a schema of its own beside the reader's
 *  (whose schema is fixed by its hash, see lib/db): what the agent made of
 *  each item, every event the devices report, and the profile it keeps. */
import { query, transaction } from "@/lib/db"
import { WORDS_PER_MINUTE } from "@/lib/markdown"
import { EMPTY_PROFILE, LABEL_VERSION, type CatalogItem, type CloudProfile, type DeviceEvent, type Labels, type Modality } from "@/lib/hybrid/types"

const SCHEMA = `
  create schema if not exists brainy;
  create table if not exists brainy.labels (
    article_id integer primary key references reader.articles on delete cascade,
    labels jsonb not null,
    labeled_at timestamptz not null default now()
  );
  create table if not exists brainy.events (
    id text primary key, -- made by the device, so a resent batch is kept once
    device text not null,
    at timestamptz not null,
    kind text not null,
    article_id integer,
    moment jsonb not null,
    data jsonb,
    received_at timestamptz not null default now()
  );
  create index if not exists events_at on brainy.events (at desc);
  create table if not exists brainy.profile (
    id integer primary key default 1 check (id = 1),
    profile jsonb not null,
    relabeling_since timestamptz -- a lease, so two requests don't relabel at once
  );
`

let made: Promise<void> | undefined
function ready(): Promise<void> {
  return made ??= transaction(async run => {
    await run("select pg_advisory_xact_lock(hashtext('brainy/schema'))")
    await run(SCHEMA)
  }).catch(error => { made = undefined; throw error })
}

const BOOKS = new Set(["EPUB", "MOBI", "AZW3", "FB2"])
const AUDIO = new Set(["MP3", "M4A", "AAC", "FLAC", "OGG", "WAV"])
const VIDEO = new Set(["MP4", "MOV", "WebM", "OGV"])

function kindOf(format: string | null, type: string | null, words: number): { kind: string; modality: Modality } {
  if ((format && AUDIO.has(format)) || type?.startsWith("audio/")) return { kind: "recording", modality: "listen" }
  if ((format && VIDEO.has(format)) || type?.startsWith("video/")) return { kind: "video", modality: "watch" }
  if ((format && BOOKS.has(format)) || words > 40_000) return { kind: "book", modality: "read" }
  if (format === "PDF") return { kind: "paper", modality: "read" }
  return { kind: "article", modality: "read" }
}

type Row = {
  id: number; title: string; site: string; image: string | null; excerpt: string | null; words: number; progress: number
  location: string; format: string | null; type: string | null; labels: Labels | null
}

/** Everything readable, out of the trash, with what the agent made of it. */
export async function catalog(profile?: CloudProfile): Promise<CatalogItem[]> {
  await ready()
  const { rows } = await query<Row>(`select a.id, a.title, a.site, a.image, a.excerpt, a.words, a.progress, a.location,
      a.format, a.source_type as type, l.labels
    from reader.articles a left join brainy.labels l on l.article_id = a.id
    where a.location <> 'trash' and (a.markdown_hash is not null or a.format is not null)
    order by a.moved_at desc, a.id desc`)
  return rows.map(({ words, format, type, ...row }) => ({
    ...row,
    ...kindOf(format, type, words),
    minutes: words ? Math.max(1, Math.round(words / WORDS_PER_MINUTE)) : 10,
    cluster: profile?.placement[row.id] ?? null,
  }))
}

/** Items the agent has not read yet, with the start of their text to read. */
export async function unlabeled(limit: number): Promise<(Row & { text: string; url: string })[]> {
  await ready()
  const { rows } = await query<Row & { text: string; url: string }>(`select a.id, a.title, a.site, a.url, a.image, a.excerpt, a.words,
      a.progress, a.location, a.format, a.source_type as type, left(a.text, 24000) as text
    from reader.articles a left join brainy.labels l on l.article_id = a.id
    where (l.article_id is null or coalesce((l.labels->>'version')::int, 1) < $2)
      and a.location <> 'trash' and (a.markdown_hash is not null or a.format is not null)
    -- Never analysed first, then the newest.
    order by l.article_id is not null, a.moved_at desc limit $1`, [limit, LABEL_VERSION])
  return rows
}

export async function saveLabels(id: number, labels: Labels): Promise<void> {
  await query(`insert into brainy.labels (article_id, labels) values ($1, $2)
    on conflict (article_id) do update set labels = excluded.labels, labeled_at = now()`, [id, JSON.stringify(labels)])
}

/** Labels made without a model, replaced once one is configured. */
export async function forgetFallbackLabels(): Promise<void> {
  await ready()
  await query("delete from brainy.labels where labels->>'labeledBy' = 'on-server rules'")
}

/** Events a device sent; those sent before are kept once. Answers how many were new. */
export async function addEvents(events: DeviceEvent[]): Promise<number> {
  if (!events.length) return 0
  await ready()
  const { rowCount } = await query(`insert into brainy.events (id, device, at, kind, article_id, moment, data)
    select * from json_to_recordset($1) as e(id text, device text, at timestamptz, kind text, article_id integer, moment jsonb, data jsonb)
    on conflict (id) do nothing`,
  [JSON.stringify(events.map(e => ({ ...e, at: new Date(e.at).toISOString(), article_id: e.articleId ?? null, data: e.data ?? null })))])
  return rowCount ?? 0
}

export async function recentEvents(limit: number): Promise<DeviceEvent[]> {
  await ready()
  const { rows } = await query<DeviceEvent>(`select id, device, extract(epoch from at) * 1000 as at, kind, article_id as "articleId", moment, data
    from brainy.events order by at desc limit $1`, [limit])
  return rows.map(row => ({ ...row, at: Number(row.at) }))
}

export async function eventCount(): Promise<number> {
  await ready()
  const { rows: [row] } = await query<{ n: number }>("select count(*)::int as n from brainy.events")
  return row.n
}

export async function profile(): Promise<CloudProfile> {
  await ready()
  const { rows: [row] } = await query<{ profile: CloudProfile }>("select profile from brainy.profile where id = 1")
  return row?.profile ?? EMPTY_PROFILE
}

/** The lease to relabel, if no one else holds it: a relabel takes the model a minute at most. */
export async function claimRelabel(): Promise<boolean> {
  await ready()
  const { rowCount } = await query(`insert into brainy.profile (id, profile, relabeling_since) values (1, $1, now())
    on conflict (id) do update set relabeling_since = now()
    where profile.relabeling_since is null or profile.relabeling_since < now() - interval '3 minutes'`, [JSON.stringify(EMPTY_PROFILE)])
  return rowCount === 1
}

export async function saveProfile(next: CloudProfile): Promise<void> {
  await query("update brainy.profile set profile = $1, relabeling_since = null where id = 1", [JSON.stringify(next)])
}

export async function releaseRelabel(): Promise<void> {
  await query("update brainy.profile set relabeling_since = null where id = 1")
}
