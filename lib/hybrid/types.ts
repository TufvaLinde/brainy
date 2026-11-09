/** The vocabulary the device and the cloud agent share. Nothing here may
 *  import server code: the phone's bundle reads it too. */

/** How a piece feels to take in. The cloud labels each item with these; the
 *  device's model maps what you say onto them. */
export const VIBES = [
  "light", "deep", "calming", "energising", "inspiring", "funny",
  "practical", "visual", "analytical", "narrative", "creative", "technical", "reflective",
] as const
export type Vibe = (typeof VIBES)[number]

/** Thinking styles, which the agent learns your appetite for by state of mind. */
export const STYLES = ["visual", "analytical", "narrative", "creative", "practical"] as const
export type Style = (typeof STYLES)[number]

export type Modality = "read" | "listen" | "watch"

/** The moods a piece is pitched for, one pitch each, so the device can speak to the moment you're in. */
export const ANGLES = ["low energy", "curious", "short on time", "need a lift", "winding down", "deep focus"] as const
export type Angle = (typeof ANGLES)[number]

/** Raise when the analysis asks for more: every item is read again by the cloud. */
export const LABEL_VERSION = 6

/** What the cloud agent knows of an item from reading all of it. */
export type Labels = {
  version?: number
  /** What kind of writing it is: "personal essay", "explainer", "speech", "research paper". */
  form?: string
  /** How it sounds: "wry and conversational", "dry, exacting". */
  tone?: string
  /** How it moves, and whether you can stop and start: "short sections, easy to dip into". */
  pace?: string
  /** The most compelling specific thing in it. */
  hook?: string
  /** What you leave with. */
  takeaway?: string
  /** A short, memorable line from the text itself, or "". */
  line?: string
  goodFor?: { moment: string; why: string }[]
  /** When it's the wrong thing to read. */
  notFor?: string
  pitches?: { angle: Angle; text: string }[]
  topics: string[]
  vibes: Vibe[]
  /** How much attention it asks for, 1 (skim on autopilot) to 5 (needs a desk). */
  demand: number
  styles: Partial<Record<Style, number>>
  /** Moments it suits, in plain words: "commute", "winding down", "deep focus". */
  suits: string[]
  summary: string
  labeledBy: string
}

/** An item as the device keeps it in its catalogue. */
export type CatalogItem = {
  id: number
  title: string
  site: string
  image: string | null
  excerpt: string | null
  minutes: number
  progress: number
  location: string
  modality: Modality
  /** The kind of thing it is: "article", "book", "paper", "recording". */
  kind: string
  labels: Labels | null
  /** The interest cluster the cloud agent last put it in. */
  cluster: string | null
}

/** What the device's model makes of a request. */
export type Intent = {
  minutes: number | null
  energy: "low" | "medium" | "high" | null
  moods: string[]
  setting: string | null
  modality: Modality | "any"
  /** False when you said you can't listen: no headphones, a quiet carriage. */
  audioOk: boolean
  vibes: Vibe[]
  topics: string[]
  avoid: string[]
}

/** The state of mind and moment an event happened in: the key the agent
 *  learns preferences by. */
export type Moment = {
  daypart: "morning" | "midday" | "afternoon" | "evening" | "night"
  energy: Intent["energy"]
  moods: string[]
  setting: string | null
  device: "phone" | "tablet" | "desktop"
  online: boolean
}

export type EventKind =
  | "asked" // said or typed a request
  | "suggested" // the agent put an item forward
  | "accepted" // said yes to a suggestion
  | "swiped" // swiped a suggestion away
  | "opened" // opened an item, from a suggestion or the sphere
  | "read" // reading progress, sent as it advances
  | "closed" // left the reader
  | "signal" // something the phone reported, such as an app opened

export type DeviceEvent = {
  id: string
  device: string
  at: number
  kind: EventKind
  articleId?: number
  moment: Moment
  data?: Record<string, unknown>
}

export type Cluster = { name: string; weight: number; topics: string[]; color: string }
export type Inference = { text: string; evidence: string; confidence: number }

/** What the cloud agent concludes about you, sent back to every device. */
export type CloudProfile = {
  version: number
  updatedAt: string
  updatedBy: string
  summary: string
  clusters: Cluster[]
  inferences: Inference[]
  /** Item id to cluster name, which lays out the sphere. */
  placement: Record<number, string>
  /** Learned leanings by moment ("tired", "commute", "evening"): style or vibe to weight, -1 to 1. */
  leanings: Record<string, Record<string, number>>
  eventsSeen: number
}

export const EMPTY_PROFILE: CloudProfile = {
  version: 0, updatedAt: new Date(0).toISOString(), updatedBy: "nobody yet", summary: "",
  clusters: [], inferences: [], placement: {}, leanings: {}, eventsSeen: 0,
}

/** The keys a moment is filed under, most specific first. */
export function momentKeys(m: Pick<Moment, "daypart" | "energy" | "moods" | "setting">): string[] {
  const keys = [...m.moods.map(mood => mood.toLowerCase())]
  if (m.energy) keys.push(`${m.energy} energy`)
  if (m.setting) keys.push(m.setting.toLowerCase())
  keys.push(m.daypart)
  return [...new Set(keys)]
}
