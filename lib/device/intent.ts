/** Turning what you say into parameters to pick by. Rules catch what must be
 *  exact (minutes, no headphones); the on-device model reads the rest, the
 *  vibe and the topic you mean, and the two are merged. */
import { VIBES, type Intent, type Moment, type Vibe } from "@/lib/hybrid/types"

export function currentMoment(intent?: Intent | null): Moment {
  const hour = new Date().getHours()
  const daypart: Moment["daypart"] = hour < 5 ? "night" : hour < 11 ? "morning" : hour < 14 ? "midday" : hour < 18 ? "afternoon" : hour < 22 ? "evening" : "night"
  const short = Math.min(screen.width, screen.height)
  const ipad = /iPad/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent))
  const device: Moment["device"] = ipad || (short >= 700 && navigator.maxTouchPoints > 0) ? "tablet" : navigator.maxTouchPoints > 0 ? "phone" : "desktop"
  return { daypart, energy: intent?.energy ?? null, moods: intent?.moods ?? [], setting: intent?.setting ?? null, device, online: navigator.onLine }
}

const NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, "forty-five": 45, sixty: 60 }
const SETTINGS: [RegExp, string, number | null][] = [
  [/\b(metro|subway|train|bus|tube|bart|caltrain|commut\w*|ride|tram)\b/i, "commute", 20],
  [/\b(flight|plane|airport)\b/i, "travel", 60],
  [/\b(bed|bedtime|before sleep|falling asleep)\b/i, "bed", 15],
  [/\b(lunch|coffee|break)\b/i, "break", 10],
  [/\b(desk|office|at work)\b/i, "work", null],
  [/\b(couch|sofa|at home|home)\b/i, "home", null],
  [/\b(gym|run|walk|walking)\b/i, "moving", 30],
]
const MOODS: [RegExp, string, Intent["energy"], Vibe[]][] = [
  [/\b(tired|exhausted|knackered|wiped|sleepy|drained|long day)\b/i, "tired", "low", ["light", "calming"]],
  [/\b(social|people all day|networking|party|crowd\w*|talking all day)\b/i, "socially drained", "low", ["calming", "reflective"]],
  [/\b(stress\w*|anxious|overwhelm\w*|frazzled)\b/i, "stressed", "low", ["calming"]],
  [/\b(sad|down|low|blue|lonely)\b/i, "low mood", "low", ["inspiring", "calming"]],
  [/\b(bored|restless)\b/i, "bored", "medium", ["funny", "energising"]],
  [/\b(curious|want to learn|learn something|nerd out)\b/i, "curious", "high", ["deep"]],
  [/\b(energi[sz]ed|pumped|wired|sharp|focused|motivated|fresh)\b/i, "energised", "high", ["deep", "energising"]],
  [/\b(happy|great day|good mood)\b/i, "happy", "medium", ["funny", "inspiring"]],
]

/** What the rules can be sure of. */
export function byRules(text: string, topics: string[]): Intent {
  const t = text.toLowerCase()
  let minutes: number | null = null
  const m = t.match(/(\d+|an?|one|two|three|four|five|ten|fifteen|twenty|thirty|forty|forty-five|sixty|half an?)\s*(?:-|\s)?\s*(min\w*|hours?|hrs?|h\b)/)
  if (m) {
    const n = m[1].startsWith("half") ? 0.5 : Number(m[1]) || NUMBERS[m[1]] || 1
    minutes = /^h/.test(m[2]) ? Math.round(n * 60) : n
  } else if (/half an hour/.test(t)) minutes = 30
  else if (/quick|short|brief/.test(t)) minutes = 7
  let setting: string | null = null
  for (const [pattern, name, typical] of SETTINGS) if (pattern.test(t)) { setting = name; minutes ??= typical; break }
  const moods: string[] = []
  let energy: Intent["energy"] = null
  const vibes = new Set<Vibe>()
  for (const [pattern, mood, e, v] of MOODS) if (pattern.test(t)) { moods.push(mood); energy ??= e; v.forEach(x => vibes.add(x)) }
  for (const vibe of VIBES) if (new RegExp(`\\b${vibe}`).test(t)) vibes.add(vibe)
  if (/\b(fun|funny|laugh)\b/.test(t)) vibes.add("funny")
  if (/\b(deep dive|dig in|meaty|serious)\b/.test(t)) vibes.add("deep")
  const noAudio = /\b(forgot|no|without|left|don'?t have)\b[^.]{0,20}\b(head ?phones|earbuds|airpods|earphones)\b|\b(quiet carriage|can'?t listen)\b/.test(t)
  const listen = !noAudio && /\b(listen|podcast|audio|ears)\b/.test(t)
  const watch = /\b(watch|video)\b/.test(t)
  const found = topics.filter(topic => topic.length > 2 && new RegExp(`\\b${escape(topic)}\\b`, "i").test(t))
  const avoid = topics.filter(topic => new RegExp(`\\b(no|not|nothing about|avoid|skip|anything but)\\b[^.]{0,20}\\b${escape(topic)}\\b`, "i").test(t))
  return {
    minutes, energy, moods, setting, modality: listen ? "listen" : watch ? "watch" : noAudio ? "read" : "any",
    audioOk: !noAudio, vibes: [...vibes], topics: found.filter(x => !avoid.includes(x)), avoid,
  }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** The JSON the on-device model answers in, constrained by its grammar. */
export const INTENT_SCHEMA = {
  type: "object",
  properties: {
    minutes: { type: ["integer", "null"] },
    energy: { enum: ["low", "medium", "high", null] },
    moods: { type: "array", items: { type: "string" } },
    setting: { type: ["string", "null"] },
    vibes: { type: "array", items: { enum: [...VIBES] } },
    topics: { type: "array", items: { type: "string" } },
    avoid: { type: "array", items: { type: "string" } },
  },
  required: ["minutes", "energy", "moods", "setting", "vibes", "topics", "avoid"],
}

export function intentPrompt(text: string, topics: string[]) {
  return [
    {
      role: "system" as const,
      content: `You turn a person's request for something to read into JSON parameters.
minutes: time they have, or null. energy: their energy, low/medium/high, or null.
moods: 1-3 words for how they feel. setting: where they are (commute, home, bed, work, break), or null.
vibes: from ${VIBES.join(", ")}. Pick what would suit them now, e.g. tired or socially drained -> light, calming.
topics: subjects they want, using these known topics where one fits: ${topics.slice(0, 40).join(", ")}.
avoid: subjects they don't want. Answer with JSON only.`,
    },
    { role: "user" as const, content: "On the train, wiped out after work, maybe something about design, not crypto" },
    { role: "assistant" as const, content: '{"minutes":20,"energy":"low","moods":["tired"],"setting":"commute","vibes":["light","visual"],"topics":["design"],"avoid":["crypto"]}' },
    { role: "user" as const, content: text },
  ]
}

/** The rules' certainties over the model's reading. */
export function merge(rules: Intent, model: Partial<Intent> | null): Intent {
  if (!model) return rules
  const list = (a: string[] = [], b: string[] = []) => [...new Set([...a, ...b].map(s => s.toLowerCase().trim()).filter(Boolean))]
  const vibes = list(rules.vibes, model.vibes).filter((v): v is Vibe => (VIBES as readonly string[]).includes(v))
  return {
    minutes: rules.minutes ?? (Number.isFinite(model.minutes) && model.minutes! > 0 && model.minutes! < 600 ? model.minutes! : null),
    energy: rules.energy ?? (["low", "medium", "high"].includes(model.energy as string) ? model.energy! : null),
    moods: list(rules.moods, model.moods).slice(0, 4),
    setting: rules.setting ?? (model.setting || null),
    modality: rules.modality,
    // Either can know you can't listen: the rules from the words, Apple's model from what they imply.
    audioOk: rules.audioOk && model.audioOk !== false,
    vibes: vibes.slice(0, 5),
    topics: list(rules.topics, model.topics).filter(t => !list(rules.avoid, model.avoid).includes(t)).slice(0, 5),
    avoid: list(rules.avoid, model.avoid).slice(0, 5),
  }
}
