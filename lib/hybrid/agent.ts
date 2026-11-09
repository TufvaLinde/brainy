/** The cloud agent's slow loop: from everything the devices saw you do, it
 *  redraws your interest sphere: the clusters it groups your library into,
 *  where each item sits, and what it infers about you by moment and mood.
 *  The devices fold what it concludes into their own fast, local profile. */
import { z } from "zod"
import { ask, configured, MODEL } from "@/lib/hybrid/claude"
import * as store from "@/lib/hybrid/store"
import {
  STYLES, VIBES, momentKeys, type CatalogItem, type CloudProfile, type Cluster, type DeviceEvent, type Inference,
} from "@/lib/hybrid/types"

/** New events it takes before the agent redraws the sphere. */
export const RELABEL_EVERY = 4

const COLORS = ["#ff7a59", "#7c5cff", "#2ec4b6", "#ffbe0b", "#ff4d8d", "#3a86ff", "#8ac926", "#f15bb5"]

const Schema = z.object({
  summary: z.string().describe("Two sentences, second person, on who this reader is right now"),
  clusters: z.array(z.object({
    name: z.string().describe("A short, specific, evocative name, 1 to 3 words"),
    weight: z.number().describe("Current pull of this interest, 0 to 1"),
    topics: z.array(z.string()),
  })).describe("4 to 7 interest clusters the library divides into, weighted by what the reader actually engages with"),
  placement: z.array(z.object({ id: z.number().int(), cluster: z.string() })).describe("Every item id given, assigned to one cluster name"),
  inferences: z.array(z.object({
    text: z.string().describe("A specific, testable inference in second person, e.g. 'When you're tired you reach for visual, creative pieces over analytical ones'"),
    evidence: z.string().describe("The events that support it, briefly"),
    confidence: z.number().describe("0 to 1"),
  })).describe("3 to 6 inferences, including ones that link state of mind, setting or time of day to what is chosen and what is passed over"),
  leanings: z.array(z.object({
    moment: z.string().describe("A moment key as given in the events, e.g. 'tired', 'commute', 'evening', 'low energy'"),
    toward: z.array(z.object({ label: z.string().describe(`One of: ${[...STYLES, ...VIBES].join(", ")}, or a topic`), weight: z.number().describe("-1 to 1") })),
  })),
})

const SYSTEM = `You are the cloud half of a hybrid personal agent. A small model on the reader's phone picks what to read in the moment;
you see the whole history and redraw the reader's interest sphere so the phone's picks get better over time.
Choices made under a stated mood or setting are the strongest signal: what someone opens when tired, after swiping
something else away, says more than what they browse idly. A swipe-away is a real negative for that moment, not overall.
Prefer specific, falsifiable inferences to generic ones. Keep cluster names stable across redraws unless the evidence moved.`

/** Redraw the profile if there are new events enough, and no other request is. */
export async function maybeRelabel(force = false): Promise<CloudProfile | null> {
  const [current, count] = await Promise.all([store.profile(), store.eventCount()])
  if (!force && count - current.eventsSeen < RELABEL_EVERY && current.version > 0) return null
  if (!(await store.claimRelabel())) return null
  try {
    const [events, items] = await Promise.all([store.recentEvents(400), store.catalog(current)])
    const next = (configured() ? await byModel(current, events, items).catch(error => {
      console.error("The agent's relabel failed, using rules:", error instanceof Error ? error.message : error)
      return null
    }) : null) ?? byRules(events, items)
    const saved: CloudProfile = { ...next, version: current.version + 1, updatedAt: new Date().toISOString(), eventsSeen: count }
    await store.saveProfile(saved)
    return saved
  } catch (error) {
    await store.releaseRelabel()
    throw error
  }
}

type Draft = Omit<CloudProfile, "version" | "updatedAt" | "eventsSeen">

async function byModel(current: CloudProfile, events: DeviceEvent[], items: CatalogItem[]): Promise<Draft | null> {
  const byId = new Map(items.map(item => [item.id, item]))
  const described = events.slice().reverse().map(e => {
    const item = e.articleId ? byId.get(e.articleId) : undefined
    const when = `${new Date(e.at).toISOString().slice(0, 16)} ${e.moment.device}, ${momentKeys(e.moment).join("/")}`
    const what = item ? ` "${item.title}" [${item.labels?.topics.join(", ") ?? "?"}; ${item.labels?.vibes.join(", ") ?? "?"}]` : ""
    const data = e.data ? ` ${JSON.stringify(e.data)}` : ""
    return `${when}: ${e.kind}${what}${data}`
  })
  const library = items.map(i => `${i.id}: ${i.title} (${i.kind}, ${i.minutes} min) [${i.labels?.topics.join(", ") ?? "unlabelled"}; ${i.labels?.vibes.join(", ") ?? ""}]`)
  const prompt = `Previous sphere (version ${current.version}):\n${JSON.stringify({ summary: current.summary, clusters: current.clusters, inferences: current.inferences })}\n\n` +
    `Library:\n${library.join("\n")}\n\nEvents, oldest first:\n${described.join("\n") || "(none yet)"}`
  const found = await ask(Schema, SYSTEM, prompt, "medium")
  if (!found) return null
  const clusters: Cluster[] = found.clusters.map((c, i) => ({ ...c, weight: Math.min(1, Math.max(0, c.weight)), color: COLORS[i % COLORS.length] }))
  const names = new Set(clusters.map(c => c.name))
  return {
    updatedBy: MODEL,
    summary: found.summary,
    clusters,
    inferences: found.inferences,
    placement: Object.fromEntries(found.placement.filter(p => names.has(p.cluster)).map(p => [p.id, p.cluster])),
    leanings: Object.fromEntries(found.leanings.map(l => [l.moment.toLowerCase(), Object.fromEntries(l.toward.map(t => [t.label, t.weight]))])),
  }
}

/** How much an event says you wanted its item, for the moment you were in. */
const SIGNAL: Partial<Record<DeviceEvent["kind"], number>> = { accepted: 1.5, opened: 1, swiped: -1, closed: 0 }
function signalOf(e: DeviceEvent): number {
  if (e.kind === "read") return 2 * Number(e.data?.progress ?? 0)
  return SIGNAL[e.kind] ?? 0
}

/** The same loop without a model: counts, not judgement, but enough to watch the sphere move. */
function byRules(events: DeviceEvent[], items: CatalogItem[]): Draft {
  const byId = new Map(items.map(item => [item.id, item]))
  const topicWeight = new Map<string, number>()
  for (const item of items) for (const t of item.labels?.topics ?? []) topicWeight.set(t, (topicWeight.get(t) ?? 0) + 0.2)
  // Per moment: the sum of each style's and vibe's presence, signed by whether it was wanted.
  const byMoment = new Map<string, { score: Map<string, number>; n: number; liked: Set<string>; passed: Set<string> }>()
  for (const e of events) {
    const item = e.articleId ? byId.get(e.articleId) : undefined
    const s = signalOf(e)
    if (!item?.labels || !s) continue
    for (const t of item.labels.topics) topicWeight.set(t, (topicWeight.get(t) ?? 0) + s)
    for (const key of momentKeys(e.moment)) {
      const m = byMoment.get(key) ?? { score: new Map(), n: 0, liked: new Set(), passed: new Set() }
      m.n++
      for (const [style, v] of Object.entries(item.labels.styles)) m.score.set(style, (m.score.get(style) ?? 0) + s * (v ?? 0))
      for (const vibe of item.labels.vibes) m.score.set(vibe, (m.score.get(vibe) ?? 0) + s * 0.5)
      ;(s > 0 ? m.liked : m.passed).add(item.labels.topics[0])
      byMoment.set(key, m)
    }
  }
  const top = [...topicWeight].sort((a, b) => b[1] - a[1]).slice(0, 6)
  const max = Math.max(1, ...top.map(([, w]) => w))
  const clusters: Cluster[] = top.map(([topic, w], i) => ({ name: topic, weight: Math.max(0.05, w / max), topics: [topic], color: COLORS[i % COLORS.length] }))
  const placement: Record<number, string> = {}
  for (const item of items) {
    const hit = item.labels?.topics.find(t => clusters.some(c => c.name === t))
    if (hit) placement[item.id] = hit
  }
  const leanings: CloudProfile["leanings"] = {}
  // One inference per finding, naming every moment it held in: "tired and commuting".
  const findings = new Map<string, { keys: string[]; n: number; make(keys: string): Inference }>()
  const find = (id: string, key: string, n: number, make: (keys: string) => Inference) => {
    const had = findings.get(id)
    if (had) { had.keys.push(key); had.n = Math.max(had.n, n) } else findings.set(id, { keys: [key], n, make })
  }
  // Moods first: what you said about yourself beats the time of day.
  const rankKey = (key: string) => DAYPARTS.has(key) ? 2 : key.endsWith("energy") ? 1 : 0
  for (const [key, m] of [...byMoment].sort((a, b) => rankKey(a[0]) - rankKey(b[0]) || b[1].n - a[1].n)) {
    const scaled = Object.fromEntries([...m.score].map(([k, v]) => [k, Math.max(-1, Math.min(1, v / m.n))]))
    leanings[key] = scaled
    if (m.n < 2) continue
    const styles = STYLES.map(s => [s, scaled[s] ?? 0] as const).sort((a, b) => b[1] - a[1])
    const [best, worst] = [styles[0], styles[styles.length - 1]]
    if (best[1] - worst[1] > 0.15) find(`style:${best[0]}:${worst[0]}`, key, m.n, keys => ({
      text: `When you're ${keys}, you lean ${best[0]} rather than ${worst[0]}.`,
      evidence: `${m.n} choices made in those moments`,
      confidence: Math.min(0.9, 0.3 + m.n * 0.1),
    }))
    const liked = [...m.liked].filter(t => !m.passed.has(t))
    const passed = [...m.passed].filter(t => !m.liked.has(t))
    if (liked.length && passed.length) find(`topic:${liked[0]}:${passed[0]}`, key, m.n, keys => ({
      text: `When you're ${keys}, ${liked[0]} pulls you more than ${passed[0]}.`,
      evidence: `opened ${liked[0]}, passed on ${passed[0]}`,
      confidence: Math.min(0.8, 0.25 + m.n * 0.05),
    }))
  }
  const inferences = [...findings.values()].slice(0, 5)
    .map(f => f.make(f.keys.slice(0, 3).map(phrase).join(", ").replace(/, ([^,]*)$/, " and $1")))
  const lead = clusters.slice(0, 3).map(c => c.name)
  return {
    updatedBy: "on-server rules",
    summary: lead.length ? `Your library leans toward ${lead.join(", ")}. ${events.length ? `Learned from ${events.length} things you did across your devices.` : "Use the app and this sharpens."}` : "",
    clusters, inferences, placement, leanings,
  }
}

const DAYPARTS = new Set(["morning", "midday", "afternoon", "evening", "night"])
const phrase = (key: string) => DAYPARTS.has(key) ? `reading in the ${key}` : key.endsWith("energy") ? `on ${key}` : key === "commute" ? "commuting" : key
