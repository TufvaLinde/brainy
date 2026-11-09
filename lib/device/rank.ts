/** Picking for the moment, on the device: what fits the time you have and
 *  how you feel, weighed by what you've chosen before in moments like it. */
import { momentKeys, STYLES, type CatalogItem, type CloudProfile, type Intent, type Moment, type Style } from "@/lib/hybrid/types"

/** The fast half of the profile: learned on the device, from every choice, the moment it's made. */
export type LocalProfile = {
  /** Moment key to label (style, vibe, topic) to weight, -1 to 1. */
  leanings: Record<string, Record<string, number>>
  /** Items swiped away, with when: kept out of picks for a while. */
  passed: Record<number, number>
  /** The last few things you said, which the on-device model keeps as context. */
  said: { text: string; at: number }[]
}
export const EMPTY_LOCAL: LocalProfile = { leanings: {}, passed: {}, said: [] }

/** Why an item fits: shown as chips, those matching what you asked lit up. */
export type Reason = { kind: "time" | "vibe" | "topic" | "learned" | "energy" | "format"; text: string; asked: boolean }
export type Pick = { item: CatalogItem; score: number; reasons: Reason[] }

const RATE = 0.18

/** Learn from a choice: what the item is, nudged toward or away from, under each key of the moment. */
export function learn(local: LocalProfile, item: CatalogItem, moment: Moment, signal: number): LocalProfile {
  const labels = item.labels
  if (!labels) return local
  const touched: Record<string, number> = {}
  for (const [style, v] of Object.entries(labels.styles)) touched[style] = v ?? 0
  for (const vibe of labels.vibes) touched[vibe] = Math.max(touched[vibe] ?? 0, 0.7)
  for (const topic of labels.topics) touched[`topic:${topic}`] = 1
  const leanings = { ...local.leanings }
  for (const key of momentKeys(moment)) {
    const row = { ...leanings[key] }
    for (const [label, strength] of Object.entries(touched)) {
      const was = row[label] ?? 0
      row[label] = Math.max(-1, Math.min(1, was + RATE * signal * strength * (1 - Math.abs(was) * 0.5)))
    }
    leanings[key] = row
  }
  const passed = { ...local.passed }
  if (signal < 0) passed[item.id] = Date.now()
  else delete passed[item.id]
  return { ...local, leanings, passed }
}

/** How strongly the moment's leanings, the device's and the cloud's, pull toward an item; and the strongest pull, put in words. */
function leaning(item: CatalogItem, keys: string[], local: LocalProfile, cloud: CloudProfile): { score: number; why: string | null } {
  const labels = item.labels!
  let score = 0, best = 0, why: string | null = null
  for (const [i, key] of keys.entries()) {
    // The most specific keys, a mood you named, count most.
    const weight = 1 / (1 + i * 0.6)
    for (const [source, row] of [["device", local.leanings[key]], ["cloud", cloud.leanings[key]]] as const) {
      if (!row) continue
      const k = source === "device" ? 1 : 0.8
      for (const style of STYLES) {
        const pull = (row[style] ?? 0) * (labels.styles[style as Style] ?? 0) * weight * k
        score += pull
        if (pull > best) { best = pull; why = `${key} → ${style}` }
      }
      for (const vibe of labels.vibes) score += (row[vibe] ?? 0) * 0.5 * weight * k
      for (const topic of labels.topics) {
        const pull = (row[`topic:${topic}`] ?? row[topic] ?? 0) * weight * k
        score += pull
        if (pull > best) { best = pull; why = `${key} → ${topic}` }
      }
    }
  }
  return { score, why: best > 0.08 ? why : null }
}

const WEEK = 7 * 24 * 3600_000

export function rank(items: CatalogItem[], intent: Intent, moment: Moment, local: LocalProfile, cloud: CloudProfile, exclude = new Set<number>()): Pick[] {
  const keys = momentKeys(moment)
  const clusterWeight = new Map(cloud.clusters.map(c => [c.name, c.weight]))
  const picks: Pick[] = []
  for (const item of items) {
    if (exclude.has(item.id)) continue
    if (!intent.audioOk && item.modality !== "read") continue
    if (intent.modality !== "any" && intent.modality !== item.modality && !(intent.modality === "listen" && item.modality === "read")) continue
    const labels = item.labels
    const reasons: Reason[] = []
    let score = 0
    const left = Math.max(1, Math.round(item.minutes * (1 - (item.progress < 0.95 ? item.progress : 0))))
    // Time: a fit is worth most; a book fits as a chapter.
    if (intent.minutes) {
      if (left <= intent.minutes * 1.15) {
        // Best when it fills the time you have; a 2-minute piece for a 20-minute ride wastes most of it.
        score += 2.2 * (1 - Math.abs(intent.minutes - left) / Math.max(intent.minutes, 1))
        reasons.push({ kind: "time", text: item.progress > 0.05 && item.progress < 0.95 ? `${left} min left · fits your ${intent.minutes}` : `${left} min · fits your ${intent.minutes}`, asked: true })
      } else if (item.kind === "book") {
        score += 0.6
        reasons.push({ kind: "time", text: `a chapter in ${intent.minutes} min`, asked: true })
      } else score -= Math.min(3, (left - intent.minutes) / intent.minutes)
    } else reasons.push({ kind: "time", text: `${left} min`, asked: false })
    if (labels) {
      const vibes = labels.vibes.filter(v => intent.vibes.includes(v))
      score += vibes.length * 0.9
      for (const v of labels.vibes) reasons.push({ kind: "vibe", text: v, asked: vibes.includes(v) })
      const hay = `${labels.topics.join(" ")} ${item.title} ${labels.summary}`.toLowerCase()
      const topics = intent.topics.filter(t => hay.includes(t.toLowerCase()))
      score += topics.length * 2.5
      for (const t of labels.topics.slice(0, 2)) reasons.push({ kind: "topic", text: t, asked: topics.some(x => t.includes(x) || x.includes(t)) })
      for (const t of topics) if (!labels.topics.some(x => x.includes(t))) reasons.push({ kind: "topic", text: t, asked: true })
      if (intent.avoid.some(a => hay.includes(a.toLowerCase()))) score -= 4
      // Energy: low energy wants an easy read; a lot of it can take a hard one.
      if (intent.energy === "low") { score += (3 - labels.demand) * 0.6; if (labels.demand <= 2) reasons.push({ kind: "energy", text: "easy on a tired brain", asked: true }) }
      if (intent.energy === "high") score += (labels.demand - 3) * 0.4
      const lean = leaning(item, keys, local, cloud)
      score += lean.score * 1.6
      if (lean.why) reasons.push({ kind: "learned", text: `you lean ${lean.why}`, asked: false })
    }
    score += (item.cluster ? clusterWeight.get(item.cluster) ?? 0 : 0) * 0.6
    if (item.progress >= 0.95) score -= 1.5
    else if (item.progress > 0.05) score += 0.3
    if (item.location === "inbox" || item.location === "later") score += 0.3
    const passedAt = local.passed[item.id]
    if (passedAt && Date.now() - passedAt < WEEK) score -= 2
    if (item.modality !== "read") reasons.push({ kind: "format", text: item.modality === "listen" ? "to listen to" : "to watch", asked: intent.modality === item.modality })
    else if (item.kind !== "article") reasons.push({ kind: "format", text: item.kind, asked: false })
    // A little chance, so the same moment doesn't always give the same answer.
    score += Math.random() * 0.25
    picks.push({ item, score, reasons })
  }
  return picks.sort((a, b) => b.score - a.score).slice(0, 8)
}
