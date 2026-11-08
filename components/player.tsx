"use client"

import { Headphones, LocateFixed, Pause, Play, SkipBack, SkipForward, X } from "lucide-react"
import { useEffect, useState, useSyncExternalStore } from "react"
import { setListened } from "@/app/actions"
import { IconButton } from "@/components/icon-button"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectGroup, SelectGroupLabel, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { articleElement, blocksOf, mark, rangeOf } from "@/lib/dom"
import { useKeys } from "@/hooks/use-keys"

/** Cartesia's narrators, from its cloud, and Kokoro's best-rated English voices, from this Mac. */
const VOICES = [
  { value: "a33f7a4c-100f-41cf-a1fd-5822e8fc253f", label: "Lauren", group: "Cartesia" },
  { value: "79f8b5fb-2cc8-479a-80df-29f7a7cf1a3e", label: "Theo", group: "Cartesia" },
  { value: "71a7ad14-091c-4e8e-a314-022ece01c121", label: "Charlotte (UK)", group: "Cartesia" },
  { value: "ef191366-f52f-447a-a398-ed8c0f2943a1", label: "Archie (UK)", group: "Cartesia" },
  { value: "af_heart", label: "Heart", group: "Kokoro, on this Mac" },
  { value: "af_bella", label: "Bella", group: "Kokoro, on this Mac" },
  { value: "am_michael", label: "Michael", group: "Kokoro, on this Mac" },
  { value: "am_fenrir", label: "Fenrir", group: "Kokoro, on this Mac" },
  { value: "bf_emma", label: "Emma (UK)", group: "Kokoro, on this Mac" },
  { value: "bm_george", label: "George (UK)", group: "Kokoro, on this Mac" },
]
const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5].map((value) => ({ value, label: `${value}×` }))
/** About the voices' pace at 1×, by which the time left is counted. */
const WORDS_PER_MINUTE = 160
/** Sentences fetched ahead of the one playing, so the next is ready when it ends. */
const AHEAD = 3
/** Keys that scroll the page: pressed, the user is looking elsewhere. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "])
/** A sentence in parts of at most 1,000 characters, broken between words where
 *  it can be: the speech route takes 5,000, and a shorter part is said sooner. */
const PARTS = /[\s\S]{1,1000}(?=\s|$)|[\s\S]{1,1000}/g

/** A sentence: where it sits in its block, and how many words it has. */
type Clip = { block: number; start: number; end: number; text: string; words: number }
/** A word said: its characters in its block, and the second its clip says it. */
type Word = { start: number; end: number; at: number }
type Spoken = { url: string; words: Word[] }
type State = {
  status: "stopped" | "loading" | "playing" | "paused"
  /** The clip being read. */
  at: number
  speed: number
  voice: string
  /** Whether the page keeps the voice in view; scrolling away stops it. */
  following: boolean
  error: string
}

/** The article's sentences, or their parts, in the order they are read. */
function clipsOf(blocks: HTMLElement[]): Clip[] {
  const sentences = new Intl.Segmenter("en", { granularity: "sentence" })
  return blocks.flatMap((block, b) =>
    [...sentences.segment(block.textContent!)].flatMap(({ segment, index }) => [...segment.matchAll(PARTS)].flatMap((part) => {
      const text = part[0].trim()
      if (!/[\p{L}\p{N}]/u.test(text)) return []
      const start = index + part.index + part[0].indexOf(text)
      return [{ block: b, start, end: start + text.length, text, words: text.split(/\s+/).length }]
    })),
  )
}

/** Quotes made straight, one character for one. */
const straight = (text: string) => text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"')

/** A sentence spoken: its audio, and where in the block each word it says
 *  falls. Words come back as written, except that Kokoro straightens quotes,
 *  so both sides are straightened, and spells numbers out, so its "1990" is
 *  not found and goes unmarked. */
async function speak(clip: Clip, voice: string, signal: AbortSignal): Promise<Spoken> {
  const response = await fetch("/api/speech", { method: "POST", signal, body: JSON.stringify({ text: clip.text, voice }) })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error)
  const text = straight(clip.text)
  let cursor = 0
  const words = (body.words as { word: string; start_time: number }[]).flatMap(({ word, start_time }) => {
    const found = /[\p{L}\p{N}]/u.test(word) ? text.indexOf(straight(word), cursor) : -1
    if (found < 0) return []
    cursor = found + word.length
    return [{ start: clip.start + found, end: clip.start + cursor, at: start_time }]
  })
  return { url: body.audio, words }
}

/** Scroll a range a third of the way down the screen: always, or once it nears an edge. */
function bringIntoView(range: Range, always = false) {
  const { top, bottom } = range.getBoundingClientRect()
  if (always || top < innerHeight * 0.15 || bottom > innerHeight * 0.8) {
    scrollBy({ top: top - innerHeight / 3, behavior: "smooth" })
  }
}

/** Reads the article aloud a sentence at a time, fetching the next few while
 *  one plays, marking the sentence and the word being said, and keeping them in
 *  view until the user scrolls elsewhere. Outside React, as it holds an audio
 *  element and a frame loop; the player draws its state. */
class Narrator {
  state: State = { status: "stopped", at: 0, speed: 1, voice: VOICES[0].value, following: true, error: "" }
  private listeners = new Set<() => void>()
  private audio?: HTMLAudioElement
  private blocks: HTMLElement[] = []
  private clips: Clip[] = []
  private spoken = new Map<number, Promise<Spoken>>()
  // Each clip asked for is a run of its own: one that loads after the next was asked for plays nothing.
  private run = 0
  private frame = 0
  private word?: Range
  private requests = new AbortController()
  private words: Word[] = []
  /** The block reached, kept for the next Listen. */
  private block: number

  constructor(private readonly about: { id: number; title: string; site: string; listenedTo: number | null }) {
    this.block = about.listenedTo ?? 0
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = () => this.state

  private set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((listener) => listener())
  }

  /** Start reading at the top of the page where the voice stopped last, or
   *  scrolled down, at the paragraph in view; at the speed and in the voice
   *  picked last time. */
  listen(article: HTMLElement) {
    this.blocks = blocksOf(article)
    this.clips = clipsOf(this.blocks)
    this.set({
      following: true,
      speed: Number(localStorage.getItem("brainy.speed")) || 1,
      voice: VOICES.find((v) => v.value === localStorage.getItem("brainy.voice"))?.value ?? VOICES[0].value,
    })
    if (navigator.mediaSession && typeof MediaMetadata !== "undefined") navigator.mediaSession.metadata = new MediaMetadata({ title: this.about.title, artist: this.about.site })
    this.mediaKeys(true)
    const inView = this.blocks.findIndex((b) => b.getBoundingClientRect().bottom > innerHeight / 2)
    const block = scrollY < 50 ? this.block : Math.max(0, inView)
    void this.play(Math.max(0, this.clips.findIndex((c) => c.block >= block)))
  }

  toggle(article: HTMLElement) {
    if (this.state.status === "stopped") this.listen(article)
    else if (this.state.status === "playing") this.pause()
    else if (this.state.status === "paused") this.resume()
  }

  /** Read clip i or, past the last, stop, to start from the top next time. */
  private async play(i: number) {
    const clip = this.clips[i]
    if (!clip) {
      this.reached(0)
      return this.stop()
    }
    const run = ++this.run
    this.reached(clip.block)
    this.set({ status: "loading", at: i, error: "" })
    // Left playing, the sentence before could end while this one loads, and
    // start the one after it instead; left paused, a resume would play it.
    this.silence()
    cancelAnimationFrame(this.frame)
    const block = this.blocks[clip.block]
    const sentence = rangeOf(block, clip.start, clip.end)
    mark("speaking-sentence", [sentence])
    mark("speaking-word", [])
    if (this.state.following) bringIntoView(sentence)
    try {
      const { url, words } = await this.fetch(i)
      void this.fetchAhead(i, run)
      for (const kept of this.spoken.keys()) if (kept < i - 1) this.spoken.delete(kept)
      if (run !== this.run) return
      const audio = new Audio(url)
      this.audio = audio
      this.words = words
      audio.onended = () => { if (run === this.run) void this.play(i + 1) }
      audio.playbackRate = this.state.speed
      await audio.play()
      if (run !== this.run) { audio.pause(); return }
      this.set({ status: "playing" })
      this.track(block, words)
    } catch (error) {
      if (run !== this.run) return
      this.pause()
      this.set({ status: "paused", error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** A clip's audio, asked for once; a failure is forgotten, to be asked for again when the clip comes up. */
  private fetch(i: number) {
    let spoken = this.spoken.get(i)
    if (!spoken) {
      spoken = speak(this.clips[i], this.state.voice, this.requests.signal)
      this.spoken.set(i, spoken)
      spoken.catch(() => { if (this.spoken.get(i) === spoken) this.spoken.delete(i) })
    }
    return spoken
  }

  /** The clips after clip i, one at a time until the run moves on, as Cartesia
   *  answers only two or three requests at once on its smaller plans. */
  private async fetchAhead(i: number, run: number) {
    for (let next = i + 1; next <= i + AHEAD && next < this.clips.length && run === this.run; next++) {
      await this.fetch(next).catch(() => {})
    }
  }

  /** Mark the word being said, a frame at a time, following it down the page. */
  private track(block: HTMLElement, words: Word[]) {
    cancelAnimationFrame(this.frame)
    let said: Word | undefined
    const tick = () => {
      const word = words.findLast((w) => w.at <= this.audio!.currentTime)
      if (word && word !== said) {
        said = word
        this.word = rangeOf(block, word.start, word.end)
        mark("speaking-word", [this.word])
        if (this.state.following) bringIntoView(this.word)
      }
      this.frame = requestAnimationFrame(tick)
    }
    tick()
  }

  /** Stop the clip's audio for good, leaving none to resume. */
  private silence() {
    this.audio?.pause()
    if (this.audio) this.audio.onended = null
    this.audio = undefined
  }

  private reached(block: number) {
    if (block === this.block) return
    this.block = block
    void setListened(this.about.id, block).catch(() => {})
  }

  pause = () => {
    this.run++
    this.audio?.pause()
    cancelAnimationFrame(this.frame)
    this.set({ status: "paused" })
  }

  resume = async () => {
    const audio = this.audio
    if (!audio || this.state.error) return this.play(this.state.at)
    const run = ++this.run
    audio.onended = () => { if (run === this.run) void this.play(this.state.at + 1) }
    try {
      await audio.play()
      if (run !== this.run) { audio.pause(); return }
      this.set({ status: "playing", error: "" })
      this.track(this.blocks[this.clips[this.state.at].block], this.words)
    } catch {
      if (run === this.run) this.set({ status: "paused", error: "Playback could not start. Try Play again." })
    }
  }

  previous = () => {
    if (this.state.status !== "stopped") void this.play(Math.max(0, this.state.at - 1))
  }

  next = () => {
    if (this.state.status !== "stopped") void this.play(this.state.at + 1)
  }

  stop = () => {
    this.run++
    this.silence()
    this.requests.abort()
    this.requests = new AbortController()
    this.spoken.clear()
    cancelAnimationFrame(this.frame)
    this.mediaKeys(false)
    mark("speaking-sentence", [])
    mark("speaking-word", [])
    this.set({ status: "stopped", error: "" })
  }

  /** The Mac's media keys and Control Center, which work the player while the voice reads. */
  private mediaKeys(on: boolean) {
    const handlers = { play: this.resume, pause: this.pause, previoustrack: this.previous, nexttrack: this.next, stop: this.stop }
    for (const [action, handler] of Object.entries(handlers)) {
      navigator.mediaSession?.setActionHandler(action as MediaSessionAction, on ? handler : null)
    }
  }

  /** Read on from the paragraph holding what was clicked, unless it was a
   *  link, or a selection being made. */
  jump = (e: MouseEvent) => {
    const target = e.target as HTMLElement
    if (this.state.status === "stopped" || getSelection()?.toString() || target.closest("a")) return
    const block = this.blocks.findIndex((b) => b.contains(target))
    const i = this.clips.findIndex((c) => c.block === block)
    if (block < 0 || i < 0) return
    this.set({ following: true })
    void this.play(i)
  }

  setSpeed = (speed: number) => {
    if (this.audio) this.audio.playbackRate = speed
    localStorage.setItem("brainy.speed", String(speed))
    this.set({ speed })
  }

  /** One step along SPEEDS: -1 slower, 1 faster. */
  stepSpeed = (by: number) => {
    const i = SPEEDS.findIndex((s) => s.value === this.state.speed) + by
    this.setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, i))].value)
  }

  setVoice = (voice: string) => {
    localStorage.setItem("brainy.voice", voice)
    this.requests.abort()
    this.requests = new AbortController()
    this.spoken.clear()
    this.set({ voice, error: "" })
    if (this.state.status !== "stopped") void this.play(this.state.at)
  }

  unfollow = () => {
    if (this.state.status !== "stopped" && this.state.following) this.set({ following: false })
  }

  refollow = () => {
    this.set({ following: true })
    if (this.word) bringIntoView(this.word, true)
  }

  minutesLeft() {
    const words = this.clips.slice(this.state.at).reduce((n, clip) => n + clip.words, 0)
    return Math.max(1, Math.round(words / WORDS_PER_MINUTE / this.state.speed))
  }
}

/** Listen, in a pill at the foot of the screen; while the voice reads, the
 *  player, as in Readwise Reader: back, play or pause, forward, the time left,
 *  Return once the user has scrolled away, speed, voice and stop. A click on
 *  a paragraph jumps there. Keys: p plays or pauses, P stops, ← and → move a
 *  sentence, , and . slow down and speed up; the Mac's media keys work too. */
export function Player({ id, title, site, listenedTo }: { id: number; title: string; site: string; listenedTo: number | null }) {
  const [narrator] = useState(() => new Narrator({ id, title, site, listenedTo }))
  const state = useSyncExternalStore(narrator.subscribe, narrator.snapshot, narrator.snapshot)
  const toggle = () => narrator.toggle(articleElement())

  useKeys({
    p: toggle,
    P: narrator.stop,
    ArrowLeft: narrator.previous,
    ArrowRight: narrator.next,
    ",": () => narrator.stepSpeed(-1),
    ".": () => narrator.stepSpeed(1),
  })

  useEffect(() => {
    const article = articleElement()
    const unfollow = () => narrator.unfollow()
    const onKeyDown = (e: KeyboardEvent) => SCROLL_KEYS.has(e.key) && unfollow()
    article.addEventListener("click", narrator.jump)
    addEventListener("wheel", unfollow, { passive: true })
    addEventListener("touchmove", unfollow, { passive: true })
    addEventListener("keydown", onKeyDown)
    return () => {
      narrator.stop()
      article.removeEventListener("click", narrator.jump)
      removeEventListener("wheel", unfollow)
      removeEventListener("touchmove", unfollow)
      removeEventListener("keydown", onKeyDown)
    }
  }, [narrator])

  const playing = state.status === "playing"
  return (
    <div className="glass fixed inset-x-0 bottom-6 z-10 mx-auto flex w-fit max-w-[calc(100%-2rem)] flex-wrap justify-center items-center gap-1 rounded-2xl p-1.5">
      {state.error && <p role="alert" className="basis-full px-2 text-sm text-destructive-foreground">{state.error}</p>}
      {state.status === "stopped" ? (
        <Button variant="ghost" onClick={toggle}>
          <Headphones />
          Listen
        </Button>
      ) : (
        <>
          <IconButton label="Previous sentence" onClick={narrator.previous}>
            <SkipBack />
          </IconButton>
          <IconButton label={playing ? "Pause" : "Play"} variant="default" loading={state.status === "loading"} onClick={toggle}>
            {playing ? <Pause /> : <Play />}
          </IconButton>
          <IconButton label="Next sentence" onClick={narrator.next}>
            <SkipForward />
          </IconButton>
          <span className="px-2 text-muted-foreground text-sm tabular-nums max-sm:hidden">
            {narrator.minutesLeft()} min left
          </span>
          {!state.following && (
            <Button variant="ghost" onClick={narrator.refollow}>
              <LocateFixed />
              Return
            </Button>
          )}
          <Choice label="Speed" value={state.speed} options={SPEEDS} onChange={narrator.setSpeed} />
          <Choice label="Voice" value={state.voice} options={VOICES} onChange={narrator.setVoice} />
          <IconButton label="Stop" onClick={narrator.stop}>
            <X />
          </IconButton>
        </>
      )}
    </div>
  )
}

/** A select that reads as a label until it is opened. */
function Choice<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string; group?: string }[]
  onChange: (value: T) => void
}) {
  return (
    <Select items={options} value={value} onValueChange={(next) => next !== null && onChange(next)}>
      <SelectTrigger size="sm" aria-label={label} className="w-auto">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Object.entries(Object.groupBy(options, (option) => option.group ?? "")).map(([group, grouped]) => (
          <SelectGroup key={group}>
            {group && <SelectGroupLabel>{group}</SelectGroupLabel>}
            {grouped!.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}
