/** The cloud agent's catalogue: each item read once, whole, as soon as it
 *  is saved, and given an analysis the phone's small model couldn't make from
 *  a title: what it is and how it sounds, the hook, what you leave with, a line
 *  worth quoting, when it suits and when it doesn't, and a pitch for each kind
 *  of moment. Devices receive it with the catalogue, so every item arrives
 *  already understood. */
import { z } from "zod"
import { ask, configured, MODEL } from "@/lib/hybrid/claude"
import { forgetFallbackLabels, saveLabels, unlabeled } from "@/lib/hybrid/store"
import { ANGLES, LABEL_VERSION, STYLES, VIBES, type Angle, type Labels, type Style, type Vibe } from "@/lib/hybrid/types"

const Schema = z.object({
  form: z.string().describe("What kind of writing it is, 1-3 words, specific: 'personal essay', 'explainer', 'commencement speech', 'research paper', 'field guide', 'polemic', 'oral history'"),
  tone: z.string().describe("How it sounds, 2-4 words: 'wry and conversational', 'dry, exacting', 'warm, unhurried'"),
  pace: z.string().describe("How it moves and whether you can stop and start, under 10 words: 'short numbered sections, easy to dip into'"),
  topics: z.array(z.string()).describe("2 to 4 short lowercase topics, most central first, specific rather than generic: 'git history' over 'programming'"),
  vibes: z.array(z.enum(VIBES)).describe("2 to 4 vibes that best describe how it feels to take in"),
  demand: z.number().int().describe("Attention it asks for: 1 skim on autopilot, 3 an engaged read, 5 needs a desk and a pen"),
  styles: z.object(Object.fromEntries(STYLES.map(s => [s, z.number()])) as Record<Style, z.ZodNumber>)
    .describe("How strongly it engages each thinking style, each 0 to 1"),
  hook: z.string().describe("The single most compelling, specific thing in it, under 25 words. Name the actual idea, story or claim, never 'this article explores'"),
  takeaway: z.string().describe("What a reader leaves with, under 20 words, concrete"),
  line: z.string().describe("One short, memorable line quoted exactly from the text, under 25 words; empty if none stands out"),
  goodFor: z.array(z.object({ moment: z.string(), why: z.string() })).describe("2 to 3 moments it suits, each with a short reason specific to this piece"),
  notFor: z.string().describe("When it's the wrong thing to read, under 15 words"),
  suits: z.array(z.string()).describe("2 to 3 short moment phrases like 'commute', 'winding down', 'deep focus', 'coffee break'"),
  summary: z.string().describe("One plain sentence, under 25 words, on what it is about"),
  pitches: z.array(z.object({ angle: z.enum(ANGLES), text: z.string() }))
    .describe(`One spoken pitch for each angle (${ANGLES.join(", ")}): a single natural sentence, under 30 words, as a well-read friend would put it to someone in that state. Each must use a different detail from the piece. No questions, no 'this article'.`),
})

const SYSTEM = `You catalogue a person's reading library so an assistant on their phone can pick the right piece for their moment and mood,
and talk about it the way a friend who has read it would. Read the whole text given. Be concrete and specific to this piece:
the hook, the line and the pitches should be impossible to reuse for any other piece. Be discriminating across a library:
demand should spread over 1 to 5, and most pieces are not both "deep" and "light".`

/** Analyse up to `limit` items not yet analysed by this version; answers how many were. */
export async function labelPending(limit = 24): Promise<number> {
  const items = await unlabeled(limit)
  const model = configured()
  let done = 0
  // A few at a time: enough to finish a library in minutes, few enough to stay under rate limits.
  for (let i = 0; i < items.length; i += 4) {
    await Promise.all(items.slice(i, i + 4).map(async item => {
      let labels: Labels | null = null
      if (model) {
        try {
          const found = await ask(Schema, SYSTEM, `Title: ${item.title}\nSite: ${item.site}\nLength: ${item.words} words\n` +
            `Format: ${item.format ?? "web article"}\n\n${item.text || item.excerpt || "(no text: work from the title and site)"}`)
          if (found) labels = {
            ...found, version: LABEL_VERSION, demand: clamp(found.demand, 1, 5), topics: found.topics.slice(0, 4),
            line: found.line && item.text.includes(found.line.slice(0, 40)) ? found.line : "", labeledBy: MODEL,
          }
        } catch (error) {
          console.error(`Analysing ${item.id} failed:`, error instanceof Error ? error.message : error)
        }
      }
      labels ??= byRules(item.title, item.site, item.text || item.excerpt || "", item.words, item.format)
      await saveLabels(item.id, labels)
      done++
    }))
  }
  return done
}

/** Once a model is configured, what the rules guessed is read again by it. */
export async function upgradeLabels(): Promise<void> {
  if (configured()) await forgetFallbackLabels()
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)))

/** Words that mark a topic. The rules' guess is coarse: it stands in only until a model reads the item. */
const TOPICS: [string, RegExp][] = [
  ["ai", /\b(ai|artificial intelligence|neural|machine learning|llm|transformer|deep learning|gpt)\b/gi],
  ["ai safety", /\b(alignment|ai safety|existential risk|x-risk)\b/gi],
  ["software", /\b(code|programming|software|developer|compiler|javascript|python|api|git|unix)\b/gi],
  ["startups", /\b(startup|founder|y combinator|venture|fundrais\w*)\b/gi],
  ["money", /\b(econom\w*|market[s]?|inflation|money|bitcoin|currency|bank\w*)\b/gi],
  ["philosophy", /\b(philosoph\w*|meaning|conscious\w*|ethic\w*|reality)\b/gi],
  ["strategy", /\b(war|strategy|enemy|general|battle|tactic\w*)\b/gi],
  ["fashion", /\b(fashion|outfit|clothing|designer|runway)\b/gi],
  ["design", /\b(design|typography|interface|aesthetic\w*)\b/gi],
  ["art", /\b(art|artist|paint\w*|museum|photograph\w*|film)\b/gi],
  ["science", /\b(science|physics|biology|experiment|universe|quantum)\b/gi],
  ["writing", /\b(writ\w+|novel\w*|prose|author|literary)\b/gi],
  ["health", /\b(health|sleep|exercise|diet|stress|wellbeing)\b/gi],
  ["work", /\b(career|job|work|craft|great work)\b/gi],
  ["history", /\b(history|century|ancient|empire)\b/gi],
]

/** The text's sentences, without what the page put around them: a heading or byline run into the first words,
 *  picture credits, and lines that only repeat the title. */
function sentences(text: string, title = ""): string[] {
  const t = title.toLowerCase().slice(0, 30)
  return (text.replace(/\b(vs|etc|e\.g|i\.e|Mr|Ms|Dr|St)\./g, "$1․").match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? [])
    .map(s => s.replace(/\b(article continues (after|below) (this )?advertisement|advertisement|read more|continue reading)\b/gi, "").trim()
      // "Rich Sutton The biggest lesson…": a name or heading run into the sentence.
      .replace(/^(?:[A-Z][\w'’-]+\s){1,5}(?=(?:The|A|An|I|In|It|We|This|When|What|Most|My|Our)\s[a-z])/, "")
      .replace(/^[a-z][\w-]*\s(?=[A-Z])/, ""))
    .filter(s => !/(feature image|photo(graph)?( by|:)|image:|courtesy of|oil on canvas|all rights reserved|licensed by|rights society|art resource|©|getty|shutterstock|subscribe|newsletter)/i.test(s))
    .filter(s => !t || !s.toLowerCase().startsWith(t))
    .map(s => s.replace(/․/g, "."))
}

/** The rules' reading: counts and patterns, not judgement, but specific to the piece where the text allows. */
function byRules(title: string, site: string, text: string, words: number, format: string | null): Labels {
  const head = text.slice(0, 16000)
  const body = `${title} ${title} ${head}`
  const scores = TOPICS.map(([topic, pattern]) => [topic, body.match(pattern)?.length ?? 0] as const).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1])
  const topics = scores.slice(0, 3).map(([topic]) => topic)
  const per = (pattern: RegExp) => (body.match(pattern)?.length ?? 0) / Math.max(1, body.length / 5000)
  const technical = per(/\b(algorithm|equation|theorem|proof|function|parameter|implementation|protocol|architecture|latency|kernel)\b/gi)
  const visual = per(/\b(colou?r|look|image|photo|picture|beautiful|light|shape|painting)\b/gi)
  const first = per(/\b(I|I'm|I've|my|me)\b/g)
  const story = per(/\b(remember|years ago|when I|story|once)\b/gi)
  const howto = per(/\b(how to|step|you should|tip[s]?|guide|try)\b/gi)
  const all = sentences(head, title)
  const average = all.length ? head.length / all.length : 120
  const styles: Record<Style, number> = {
    analytical: round(Math.min(1, 0.2 + technical / 3)),
    visual: round(Math.min(1, 0.1 + visual / 4)),
    narrative: round(Math.min(1, 0.1 + (story + first / 4) / 6)),
    practical: round(Math.min(1, 0.1 + howto / 4)),
    creative: round(Math.min(1, 0.1 + (visual + story) / 8)),
  }
  const demand = clamp(1 + (words > 6000 ? 2 : words > 2000 ? 1 : 0) + (technical > 1.5 ? 2 : technical > 0.5 ? 1 : 0), 1, 5)
  const vibes: Vibe[] = [demand >= 4 ? "deep" : demand <= 2 ? "light" : "reflective"]
  if (styles.analytical > 0.5) vibes.push("analytical")
  if (styles.visual > 0.4) vibes.push("visual")
  if (styles.narrative > 0.4) vibes.push("narrative")
  if (styles.practical > 0.4) vibes.push("practical")
  if (/\b(inspir\w*|dream|great work|commencement|passion)\b/i.test(body)) vibes.push("inspiring")
  if (/\b(funny|joke|absurd|ridiculous)\b/i.test(body)) vibes.push("funny")

  const form = format === "PDF" ? (/\babstract\b/i.test(head.slice(0, 3000)) ? "research paper" : "document")
    : ["EPUB", "MOBI", "AZW3"].includes(format ?? "") || words > 40_000 ? "book"
    : /commencement|address|speech|lecture/i.test(title + head.slice(0, 2000)) ? "speech"
    : /^how\b|guide|tutorial|getting started/i.test(title) ? "how-to"
    : /interview|q&a/i.test(title) ? "interview"
    : first > 6 ? "personal essay"
    : technical > 1 ? "technical explainer"
    : words < 800 ? "short note" : "essay"
  const tone = [first > 6 ? "personal" : technical > 1 ? "exacting" : "measured", (head.match(/\?/g)?.length ?? 0) > all.length / 8 ? "questioning" : average < 90 ? "brisk" : average > 160 ? "unhurried" : "plain-spoken"].join(", ")
  const pace = words < 900 ? "one short sitting" : average < 90 ? "short sentences, quick to move through" : average > 160 ? "long, winding sentences; give it your attention" : words > 6000 ? "long; reads well in several sittings" : "steady, one argument start to finish"

  // A line worth quoting: short, whole, from the body, without figures or links.
  const quotable = all.slice(3, 200).filter(s => s.length > 50 && s.length < 150 && /^[A-Z"“]/.test(s) && !/\d{3,}|http|\(|\[|:/.test(s))
  const line = quotable.sort((a, b) => score(b) - score(a))[0] ?? ""
  const opening = all.slice(0, 12).find(s => s.length > 60 && s.length < 220 && /^[A-Z"“]/.test(s)) ?? ""
  const hook = (opening || title).replace(/\s+/g, " ")
  const minutes = Math.max(1, Math.round(words / 230))
  const mins = `${minutes} minute${minutes === 1 ? "" : "s"}`
  const topic = topics[0] ?? site.replace(/^www\./, "")
  const pitches: { angle: Angle; text: string }[] = [
    { angle: "low energy", text: demand <= 2 ? `It's ${tone.split(",")[0]} and easy going, ${mins} about ${topic} that won't ask much of you.` : `It asks for some attention, but the ${form} carries you if you let it.` },
    { angle: "curious", text: line ? `There's a line in it that sticks: "${line}"` : `A ${form} on ${topic} that opens with: ${trim(hook, 140)}` },
    { angle: "short on time", text: minutes <= 10 ? `${mins}, start to finish.` : `It's ${mins}, but ${pace.includes("sittings") ? "it stops well partway" : "the opening alone is worth it"}.` },
    { angle: "need a lift", text: vibes.includes("inspiring") ? `It's the kind of ${form} that leaves you wanting to make something.` : `A change of subject: ${topic}, told in ${article(tone.split(", ")[1] ?? "plain")} voice.` },
    { angle: "winding down", text: `${form.charAt(0).toUpperCase()}${form.slice(1)}, ${pace}.` },
    { angle: "deep focus", text: demand >= 4 ? `A real ${form} on ${topic}: ${mins} to give your full attention to.` : `Not heavy, but there's more in it on a close read than a skim.` },
  ]
  return {
    version: LABEL_VERSION,
    form, tone, pace, hook, line,
    takeaway: trim(all.slice(-8).find(s => s.length > 60 && s.length < 200) ?? hook, 160),
    topics: topics.length ? topics : [site.replace(/^www\./, "")],
    vibes: [...new Set(vibes)].slice(0, 4),
    demand,
    styles,
    goodFor: demand <= 2
      ? [{ moment: "commute", why: `${mins}, ${pace}` }, { moment: "coffee break", why: "light enough to start and finish" }]
      : demand >= 4 ? [{ moment: "deep focus", why: `a ${form} that rewards attention` }, { moment: "weekend morning", why: "worth an unhurried read" }]
      : [{ moment: "evening", why: `${tone}, ${pace}` }, { moment: "weekend", why: `a good ${form} on ${topic}` }],
    notFor: demand >= 4 ? "a tired brain or a crowded train" : minutes > 25 ? "a five-minute gap" : "when you want to be challenged",
    suits: demand <= 2 ? ["commute", "coffee break"] : demand >= 4 ? ["deep focus"] : ["evening", "weekend"],
    summary: trim(hook, 180),
    pitches,
    labeledBy: "on-server rules",
  }
}

const article = (word: string) => `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`
const round = (n: number) => Math.round(n * 100) / 100
const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : s)
/** How quotable a sentence is: plain words, a turn of thought, not a list. */
const score = (s: string) => (/\b(is|are|never|always|only|nothing|everything|best|worst)\b/i.test(s) ? 2 : 0) - (s.match(/,/g)?.length ?? 0) * 0.5 - Math.abs(s.length - 90) / 60
