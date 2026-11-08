"use client"

import { TableOfContents } from "lucide-react"
import Image from "next/image"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverClose, PopoverContent, PopoverCreateHandle, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ARTICLE_ID, articleElement } from "@/lib/dom"
import { cn } from "@/lib/utils"

/** An entry of an article's contents: its heading, by its place among the
 *  page's, and the minutes it takes to read (see contentsOf in lib/markdown). */
type Entry = { level: number; text: string; place: number; minutes: number }

const HEADINGS = "h1, h2, h3, h4, h5, h6"

/** The contents card, and how it lines up with what opened it. */
const card = PopoverCreateHandle<"start" | "center">()

function onScroll(changed: () => void) {
  addEventListener("scroll", changed, { passive: true })
  addEventListener("resize", changed)
  return () => {
    removeEventListener("scroll", changed)
    removeEventListener("resize", changed)
  }
}

/** The article's contents to go to, as Apple Books shows a book's: a card of
 *  the glass that floats above the page, the cover and title at its head, and
 *  each chapter below, its sections indented under it, with the minutes it
 *  takes to read. A book's are as its table of contents gives them; a long
 *  article's are its parts. It opens from above the article or, once that is
 *  scrolled away, from the running head, which names the chapter being read.
 *  The entry being read, the last whose heading's top is above the upper third
 *  of the screen, is marked, and in the middle of the list as it opens.
 *  Offered for three entries or more. */
export function Contents({ entries, title, byline, cover }: {
  entries: Entry[]
  title: string
  byline: string | null
  cover: string | null
}) {
  const [away, setAway] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const current = useRef<HTMLButtonElement>(null)
  const reading = useSyncExternalStore(
    onScroll,
    () => {
      // None before the article is on the page, as when it is navigated to.
      const headings = document.getElementById(ARTICLE_ID)?.querySelectorAll(HEADINGS)
      return headings ? entries.findLastIndex((entry) => headings[entry.place].getBoundingClientRect().top < innerHeight / 3) : -1
    },
    () => -1,
  )

  useEffect(() => {
    if (!button.current) return
    const observer = new IntersectionObserver(([seen]) => setAway(!seen.isIntersecting))
    observer.observe(button.current)
    return () => observer.disconnect()
  }, [])

  if (entries.length < 3) return null
  const depths = depthsOf(entries)
  // The outermost entry that holds the one being read.
  const chapter = reading < 0 ? -1 : depths.lastIndexOf(0, reading)

  return (
    <>
      <PopoverTrigger handle={card} payload="start" ref={button} render={<Button variant="ghost" size="sm" />}>
        <TableOfContents /> Contents
      </PopoverTrigger>
      {/* Text scrolls away under the running head, as under Apple's toolbars, rather than into it. */}
      {away && <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-10 h-16 bg-background/70 mask-b-from-40% backdrop-blur-sm" />}
      {away && (
        <PopoverTrigger
          handle={card}
          payload="center"
          className="glass fixed top-3 left-1/2 z-10 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-full px-3.5 py-1.5 text-sm sm:max-w-sm"
        >
          <TableOfContents className="size-4 shrink-0 text-muted-foreground" />
          <span dir="auto" className="truncate">{chapter >= 0 ? entries[chapter].text : "Contents"}</span>
        </PopoverTrigger>
      )}
      <Popover handle={card}>
        {({ payload }) => (
          <PopoverContent align={payload} sideOffset={8} initialFocus={current} className="w-88 max-w-[calc(100vw-1.5rem)] rounded-2xl">
            {/* Capped by the screen, not the space the card is given, which is measured
                from the card: one measured whole fits neither above nor below what
                opened it, and is set beside it. */}
            <div className="grid max-h-[min(36rem,calc(100dvh-16rem))] grid-rows-[auto_minmax(0,1fr)] gap-2">
              <div className="flex items-center gap-3">
                {cover && <Image src={cover} alt="" width={48} height={72} className="h-18 w-12 shrink-0 rounded-[3px] object-cover shadow-md" />}
                <div className="min-w-0">
                  <p dir="auto" className="line-clamp-2 font-article font-semibold leading-snug">{title}</p>
                  {byline && <p dir="auto" className="mt-0.5 truncate text-muted-foreground text-sm">{byline}</p>}
                </div>
              </div>
              {/* A block, which its negative margins widen, as they do not the scroll area's full width. */}
              <div className="-mx-2 min-h-0">
                <Outline entries={entries} depths={depths} reading={reading} current={current} />
              </div>
            </div>
          </PopoverContent>
        )}
      </Popover>
    </>
  )
}

/** The entries in order, each indented as deep as the entries it is part of.
 *  The entry being read is focused as the card opens; focusing the first
 *  instead would scroll the list back to the top. */
function Outline({ entries, depths, reading, current }: {
  entries: Entry[]
  depths: number[]
  reading: number
  current: React.RefObject<HTMLButtonElement | null>
}) {
  const list = useRef<HTMLOListElement>(null)

  // The entry being read in the middle of the list as it opens; not by
  // scrollIntoView, which would scroll the page as well.
  useEffect(() => {
    const row = list.current!.querySelector<HTMLElement>("[aria-current]")
    const viewport = list.current!.closest<HTMLElement>("[data-slot=scroll-area-viewport]")!
    if (row) viewport.scrollTop = row.offsetTop - (viewport.clientHeight - row.offsetHeight) / 2
  }, [])

  return (
    <ScrollArea scrollFade overscrollContain>
      <ol ref={list} className="relative grid gap-px py-1 text-sm">
        {entries.map((entry, at) => (
          <li key={at}>
            <PopoverClose
              ref={at === reading ? current : undefined}
              aria-current={at === reading ? "location" : undefined}
              className={cn(
                "flex w-full items-baseline gap-3 rounded-lg py-1.5 pe-2 text-start leading-snug hover:bg-accent",
                "aria-[current]:bg-foreground/8 aria-[current]:font-medium aria-[current]:text-foreground",
                depths[at] ? "text-muted-foreground hover:text-foreground" : "text-foreground",
              )}
              style={{ paddingInlineStart: `${0.5 + depths[at]}rem` }}
              onClick={() => articleElement().querySelectorAll(HEADINGS)[entry.place].scrollIntoView()}
            >
              <span dir="auto" className="min-w-0 flex-1">{entry.text}</span>
              <span className="shrink-0 font-normal text-muted-foreground text-xs tabular-nums">{entry.minutes} min</span>
            </PopoverClose>
          </li>
        ))}
      </ol>
    </ScrollArea>
  )
}

/** How many entries each entry is a section of. */
function depthsOf(entries: Entry[]): number[] {
  const within: Entry[] = []
  return entries.map((entry) => {
    while (within.length && within.at(-1)!.level >= entry.level) within.pop()
    within.push(entry)
    return within.length - 1
  })
}

/** A note's mark, a superscript that links to a place in the book (see
 *  lib/formats/epub), opens the note in a popover beside it, so the reader keeps
 *  their place; the note where the book has it is a link away. */
export function Notes() {
  const [note, setNote] = useState<{ mark: Element; html: string; href: string } | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const article = articleElement()
    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element).closest('a[href^="#reader-"]')
      if (!link || link.children.length !== 1 || link.firstElementChild!.localName !== "sup") return
      const href = link.getAttribute("href")!
      const block = document.getElementById(href.slice(1))?.closest("p, li, blockquote, dd, td")
      if (!block || block.contains(link)) return
      event.preventDefault()
      // Its anchors' ids are the article's, which must stay one of each.
      const copy = block.cloneNode(true) as Element
      for (const element of copy.querySelectorAll("[id]")) element.removeAttribute("id")
      setNote({ mark: link, html: copy.innerHTML, href })
      setOpen(true)
    }
    article.addEventListener("click", onClick)
    return () => article.removeEventListener("click", onClick)
  }, [])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverContent anchor={note?.mark} className="w-96">
        {note && (
          <div className="grid gap-3 text-sm">
            <div className="leading-relaxed [&_a]:underline" dir="auto" dangerouslySetInnerHTML={{ __html: note.html }} />
            <a href={note.href} className="text-muted-foreground underline hover:text-foreground" onClick={() => setOpen(false)}>
              Go to note
            </a>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
