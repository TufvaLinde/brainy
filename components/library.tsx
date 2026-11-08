"use client"

import { Archive, CircleAlert, Clock, Inbox, RotateCw, Rss, Search, SearchX, Square, SquareCheck, Trash2, Upload, X } from "lucide-react"
import { getImageProps } from "next/image"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { createSHA256 } from "hash-wasm"
import { Fragment, useEffect, useEffectEvent, useRef, useState, useTransition } from "react"
import { useFormStatus } from "react-dom"
import { emptyTrash, move, moveAndReturn, retry, saveUploads, submit, unsubscribe, uploadTargets } from "@/app/actions"
import { IconButton } from "@/components/icon-button"
import { Alert, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs"
import { toastManager } from "@/components/ui/toast"
import type { ArticleSummary, Location } from "@/lib/db"
import { useKeys } from "@/hooks/use-keys"

const NAMES: Record<Location, string> = { inbox: "Inbox", feed: "Feed", later: "Later", archive: "Archive", trash: "Trash" }
const ICONS = { inbox: Inbox, feed: Rss, later: Clock, archive: Archive, trash: Trash2 }
const LOCATIONS = Object.keys(NAMES) as Location[]
const EMPTY: Record<Location | "search", { title: string; description: string }> = {
  inbox: { title: "Nothing new", description: "Paste links, or drop books, documents, images, recordings or text files here." },
  feed: { title: "Nothing new", description: "Paste a feed’s address, or drop an OPML file here, to subscribe." },
  later: { title: "Nothing for later", description: "Press l on an article to keep it here." },
  archive: { title: "Nothing archived", description: "Press e on an article you are done with." },
  trash: { title: "Nothing in the trash", description: "Press # on an article to put it here, with its highlights, until the trash is emptied." },
  search: { title: "Nothing matches", description: "Search reads titles, authors, text and notes, as a web search box does." },
}

const SHORTCUTS = [
  ["j k", "Next, previous"],
  ["Enter", "Open"],
  ["x", "Select"],
  ["e l i", "Archive, later, inbox"],
  ["#", "Trash"],
  ["/", "Search or save"],
  ["p", "Listen, pause"],
  ["← →", "Previous, next sentence"],
  [", .", "Slower, faster"],
  ["h", "Highlight"],
  ["n", "Note"],
]

/** A location's articles, or a search's, which stay listed as they move.
 *  Triaged as in Readwise Reader: j and k move the focus from card to card, e,
 *  l and i move the focused one, # puts it in the trash; x selects cards to
 *  move together instead. A change can be undone while its toast shows;
 *  every change is persisted before success is shown.
 *  Emptying the trash is the one change that can't be undone. While some
 *  are still being read, the list is asked for again every second or so.
 *  A long list shows its first cards; more, the address that lists more of
 *  them, if there are. Files are saved from the picker, or dropped anywhere
 *  on the page, sent straight to the bucket; Export downloads the whole
 *  library as a zip, which restores it when saved so. */
export function Library({
  cards,
  more,
  location,
  query,
  error,
  accept,
  feeds,
}: {
  cards: ArticleSummary[]
  more: string | null
  location: Location | null
  query: string
  error?: string
  accept: string
  /** The feeds subscribed to, listed on the Feed. */
  feeds: string[]
}) {
  // Hidden at once, before the server's next render leaves them out.
  const [hidden, setHidden] = useState<number[]>([])
  const [help, setHelp] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const files = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const router = useRouter()
  const shown = cards.filter((card) => !hidden.includes(card.id))

  const reading = cards.some((card) => card.waiting)
  useEffect(() => {
    if (!reading) return
    const timer = setInterval(() => router.refresh(), 1500)
    return () => clearInterval(timer)
  }, [reading, router])

  /** Send the files to the bucket, have them saved, then open what they came to. */
  const upload = async (picked: File[]) => {
    if (!picked.length || uploading) return
    setUploading(true)
    try {
      const files = []
      for (const file of picked) files.push({ size: file.size, hash: await sha256(file) })
      const sending = await uploadTargets(files)
      if ("error" in sending) return router.push(`/?${new URLSearchParams({ error: sending.error })}`)
      await Promise.all(sending.targets.map(async ({ url, checksum }, i) => {
        const sent = await fetch(url, { method: "PUT", body: picked[i], headers: { "x-amz-checksum-sha256": checksum } })
        if (!sent.ok) throw new Error(`The bucket answered ${sent.status}`)
      }))
      router.push(await saveUploads(sending.targets.map(({ upload }, i) => ({ upload, name: picked[i].name, type: picked[i].type }))))
      router.refresh()
    } catch {
      toastManager.add({ title: "Could not upload that. Please try again.", type: "error" })
    } finally {
      setUploading(false)
    }
  }
  const onDrop = useEffectEvent((e: DragEvent) => {
    e.preventDefault()
    void upload([...(e.dataTransfer?.files ?? [])])
  })

  useEffect(() => {
    const allow = (e: DragEvent) => e.preventDefault()
    addEventListener("dragover", allow)
    addEventListener("drop", onDrop)
    return () => {
      removeEventListener("dragover", allow)
      removeEventListener("drop", onDrop)
    }
  }, [])

  const hide = (ids: number[]) => setHidden((hidden) => [...hidden, ...ids])
  const unhide = (ids: number[]) => setHidden((hidden) => hidden.filter((id) => !ids.includes(id)))

  const [selected, setSelected] = useState<number[]>([])
  const picked = shown.filter((card) => selected.includes(card.id))
  const select = (id: number) => setSelected((ids) => (ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id]))

  const busy = useRef(new Set<number>())
  /** Cards moved, hidden at once if they leave the list, and said in a toast
   *  that can undo it, putting each back where it was. */
  const moveCards = async (cards: ArticleSummary[], to: Location) => {
    const moving = cards.filter((card) => card.location !== to && !busy.current.has(card.id))
    if (!moving.length) return
    const ids = moving.map((card) => card.id)
    ids.forEach((id) => busy.current.add(id))
    // A search lists every location, so a card moved stays in it.
    if (location !== null) hide(ids)
    try {
      await move(ids, to)
      const moved = to === "archive" ? "archived" : `moved to ${NAMES[to]}`
      offerUndo(moving.length > 1 ? `${moving.length} ${moved}` : moved[0].toUpperCase() + moved.slice(1), async () => {
        try {
          for (const [from, back] of Object.entries(Object.groupBy(moving, (card) => card.location))) {
            await move(back!.map((card) => card.id), from as Location)
          }
          unhide(ids)
          router.refresh()
        } catch { toastManager.add({ title: "Could not undo that change. Please try again.", type: "error" }) }
      })
    } catch {
      unhide(ids)
      toastManager.add({ title: "Could not save that change. Please try again.", type: "error" })
    } finally { ids.forEach((id) => busy.current.delete(id)) }
  }

  const focused = () => {
    const item = document.activeElement?.closest<HTMLElement>("[data-card]")
    return shown.findIndex((card) => String(card.id) === item?.dataset.card)
  }
  const focus = (i: number) => document.querySelector<HTMLElement>(`[data-card="${shown[i]?.id}"] a`)?.focus()

  /** Act on the focused card, passing the focus on first, as Gmail does: the
   *  card may be about to go. */
  const onFocused = (does: (card: ArticleSummary) => void) => {
    const i = focused()
    if (i < 0) return
    focus(i + 1 < shown.length ? i + 1 : i - 1)
    does(shown[i])
  }

  /** Move the selected cards, if any are, or else the focused one. */
  const moveTo = (to: Location) => {
    if (!picked.length) return onFocused((card) => void moveCards([card], to))
    setSelected([])
    void moveCards(picked, to)
  }

  const next = () => focus(focused() + 1)
  const previous = () => focus(Math.max(0, focused() - 1))
  useKeys({
    j: next,
    k: previous,
    ArrowDown: next,
    ArrowUp: previous,
    x: () => { const i = focused(); if (i >= 0) select(shown[i].id) },
    e: () => moveTo("archive"),
    l: () => moveTo("later"),
    i: () => moveTo("inbox"),
    "#": () => moveTo("trash"),
    "/": () => field.current?.focus(),
    "?": () => setHelp((open) => !open),
  })

  const empty = EMPTY[location ?? "search"]
  const EmptyIcon = location ? ICONS[location] : SearchX
  return (
    <>
      <form action={submit}>
        <InputGroup>
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            ref={field}
            name="q"
            type="search"
            size="lg"
            defaultValue={query}
            placeholder="Search, or paste links to save"
            aria-label="Search, or paste links to save"
            onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
          />
          <Saving />
        </InputGroup>
      </form>
      {error && (
        <Alert variant="error" role="alert" className="mt-3">
          <CircleAlert />
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      )}

      <input
        ref={files}
        type="file"
        multiple
        accept={accept}
        hidden
        onChange={(e) => {
          const picked = [...(e.currentTarget.files ?? [])]
          // Emptied, so the same file chosen again is sent again.
          e.currentTarget.value = ""
          void upload(picked)
        }}
      />

      <nav className="mt-6 flex items-center gap-1">
        <Tabs value={location}>
          <TabsList variant="underline">
            {LOCATIONS.map((place) => (
              <TabsTab key={place} value={place} nativeButton={false} render={<Link href={place === "inbox" ? "/" : `/?in=${place}`} />}>
                {NAMES[place]}
              </TabsTab>
            ))}
          </TabsList>
        </Tabs>
        {picked.length ? (
          <div className="ms-auto flex items-center">
            <span className="px-2 text-muted-foreground text-sm tabular-nums">{picked.length} selected</span>
            <MoveButtons from={location} onMove={moveTo} />
            <IconButton label="Clear selection" size="icon-sm" className="text-muted-foreground" onClick={() => setSelected([])}>
              <X />
            </IconButton>
          </div>
        ) : location === "trash" ? (
          <EmptyTrash disabled={!shown.length} />
        ) : location === "feed" ? (
          <Subscriptions feeds={feeds} />
        ) : (
          <Button variant="ghost" size="sm" className="ms-auto text-muted-foreground" disabled={uploading} onClick={() => files.current!.click()}>
            {uploading ? <Spinner /> : <Upload />}
            Upload
          </Button>
        )}
      </nav>

      <ul className="mt-3">
        {shown.map((card) => (
          <Card
            key={card.id}
            card={card}
            inSearch={!location}
            selected={selected.includes(card.id)}
            onSelect={() => select(card.id)}
            moveTo={(to) => void moveCards([card], to)}
          />
        ))}
      </ul>
      {more && (
        <Button render={<Link href={more} scroll={false} />} variant="ghost" size="sm" className="mt-2 w-full text-muted-foreground">
          Show more
        </Button>
      )}
      {!shown.length && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <EmptyIcon />
            </EmptyMedia>
            <EmptyTitle>{empty.title}</EmptyTitle>
            <EmptyDescription>{empty.description}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      <footer className="mt-12 flex items-center justify-between gap-4 text-muted-foreground text-xs">
        <p>
          Drag{" "}
          <a
            // React writes no javascript: address, so the bookmarklet is set on the element itself.
            ref={(a) => a?.setAttribute("href", bookmarklet(window.location.origin))}
            className="font-medium text-foreground"
          >
            Save to Brainy
          </a>{" "}
          to your bookmarks bar to save the page you’re on, as you see it.
        </p>
        <div className="flex shrink-0 items-center">
          <Button render={<a href="/export" />} variant="ghost" size="xs" className="text-muted-foreground">
            Export
          </Button>
          <Popover open={help} onOpenChange={setHelp}>
            <PopoverTrigger render={<Button variant="ghost" size="xs" className="text-muted-foreground" />}>
              Shortcuts <Kbd>?</Kbd>
            </PopoverTrigger>
            <PopoverContent side="top" align="end">
              <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2">
                {SHORTCUTS.map(([keys, does]) => (
                  <Fragment key={keys}>
                    <dt>
                      <KbdGroup>
                        {keys.split(" ").map((key) => (
                          <Kbd key={key}>{key}</Kbd>
                        ))}
                      </KbdGroup>
                    </dt>
                    <dd className="text-muted-foreground">{does}</dd>
                  </Fragment>
                ))}
              </dl>
            </PopoverContent>
          </Popover>
        </div>
      </footer>
    </>
  )
}

function Card({
  card,
  inSearch,
  selected,
  onSelect,
  moveTo,
}: {
  card: ArticleSummary
  inSearch: boolean
  selected: boolean
  onSelect: () => void
  moveTo: (to: Location) => void
}) {
  const left = card.progress >= 0.99 ? "Read" : `${card.minutesLeft} min${card.progress > 0 ? " left" : ""}`
  const read = !card.waiting && !card.error
  return (
    <li data-card={card.id} className="group relative">
      <Link
        // Not yet read, it can only be opened where it came from: its page, or the file it was.
        href={read ? `/read/${card.id}` : /^https?:/.test(card.url) ? card.url : `/read/${card.id}/original`}
        target={read ? undefined : "_blank"}
        data-selected={selected || undefined}
        className="flex gap-4 rounded-xl p-3 outline-none transition-colors hover:bg-accent focus-visible:bg-accent data-selected:bg-accent"
      >
        <Avatar className="size-14 rounded-lg">
          {card.image && <AvatarImage {...thumbnail(card.image)} />}
          <AvatarFallback className="rounded-lg text-lg text-muted-foreground uppercase">{card.site[0]}</AvatarFallback>
        </Avatar>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{card.title}</span>
          {card.excerpt && <span className="mt-0.5 line-clamp-2 text-muted-foreground">{card.excerpt}</span>}
          <span className="mt-1.5 flex items-center gap-1.5 text-muted-foreground text-xs">
            {card.waiting && <Spinner className="size-3" />}
            <span className={card.error ? "text-destructive-foreground" : undefined}>
              {card.site} · {card.waiting ? "Saving" : (card.error ?? left)}
            </span>
            {card.format && <Badge variant="outline" size="sm">{card.format}</Badge>}
            {inSearch && <Badge variant="secondary" size="sm">{NAMES[card.location]}</Badge>}
          </span>
        </span>
      </Link>
      <div className="absolute right-3 bottom-2 flex opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
        {/* Nothing in the trash is read, so trying one there again would wait forever. */}
        {card.error && card.location !== "trash" && (
          <IconButton
            label="Try again"
            size="icon-sm"
            className="text-muted-foreground"
            onClick={() => void retry(card.id).catch(() => toastManager.add({ title: "Could not save that change. Please try again.", type: "error" }))}
          >
            <RotateCw />
          </IconButton>
        )}
        <MoveButtons from={card.location} onMove={moveTo} />
        <IconButton label={selected ? "Deselect" : "Select"} size="icon-sm" className="text-muted-foreground" onClick={onSelect}>
          {selected ? <SquareCheck /> : <Square />}
        </IconButton>
      </div>
    </li>
  )
}

/** A button to each location but the one the articles are in, and the Feed, which only its feeds fill. */
function MoveButtons({ from, onMove }: { from: Location | null; onMove: (to: Location) => void }) {
  return LOCATIONS.filter((to) => to !== from && to !== "feed").map((to) => {
    const Icon = ICONS[to]
    return (
      <IconButton key={to} label={NAMES[to]} size="icon-sm" className="text-muted-foreground" onClick={() => onMove(to)}>
        <Icon />
      </IconButton>
    )
  })
}

/** The reading view's triage, by the library's keys: e or the button archives
 *  the article, l and i move it to later or the inbox, # puts it in the trash,
 *  and each goes back to the library. */
export function Triage({ id, location }: { id: number; location: Location }) {
  const [moving, startMoving] = useTransition()
  const moveTo = (to: Location) => {
    if (to !== location && !moving) startMoving(() => moveAndReturn(id, to))
  }
  useKeys({ e: () => moveTo("archive"), l: () => moveTo("later"), i: () => moveTo("inbox"), "#": () => moveTo("trash") })
  return (
    location !== "archive" && (
      <IconButton label="Archive" loading={moving} onClick={() => moveTo("archive")}>
        <Archive />
      </IconButton>
    )
  )
}

/** The feeds subscribed to, each a click from unsubscribing; what they brought stays. */
function Subscriptions({ feeds }: { feeds: string[] }) {
  const stop = (url: string) =>
    void unsubscribe(url).catch(() => toastManager.add({ title: "Could not unsubscribe. Please try again.", type: "error" }))
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="ghost" size="sm" className="ms-auto text-muted-foreground" />}>
        <Rss />
        {feeds.length} {feeds.length === 1 ? "feed" : "feeds"}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        {feeds.length ? (
          <ul className="grid gap-1 text-sm">
            {feeds.map((url) => (
              <li key={url} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{url.replace(/^https?:\/\/(www\.)?/, "")}</span>
                <IconButton label="Unsubscribe" size="icon-sm" className="text-muted-foreground" onClick={() => stop(url)}>
                  <X />
                </IconButton>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">Paste a feed’s address to subscribe.</p>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** Delete the trash's articles for good, once asked: all of them, not only those listed. */
function EmptyTrash({ disabled }: { disabled: boolean }) {
  const empty = () =>
    void emptyTrash().catch(() => toastManager.add({ title: "Could not empty the trash. Please try again.", type: "error" }))
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={<Button variant="ghost" size="sm" className="ms-auto text-muted-foreground" disabled={disabled} />}
      >
        <Trash2 />
        Empty Trash
      </AlertDialogTrigger>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Empty the trash?</AlertDialogTitle>
          <AlertDialogDescription>
            Every article in it, with its highlights and notes, will be deleted for good.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <AlertDialogClose render={<Button variant="destructive" onClick={empty} />}>Delete for good</AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  )
}

/** A card's picture at the card's size, as Next shrinks it, rather than the
 *  whole picture sent for a thumbnail. */
const thumbnail = (src: string) => getImageProps({ src, alt: "", width: 56, height: 56 }).props

/** While the links go in; each is read after, on its card. */
function Saving() {
  const { pending } = useFormStatus()
  return (
    pending && (
      <InputGroupAddon align="inline-end">
        <Spinner />
      </InputGroupAddon>
    )
  )
}

/** Posts the page open in the browser, as the browser has it, to be saved
 *  and opened to read in its place. */
const bookmarklet = (origin: string) =>
  `javascript:(()=>{const f=document.createElement('form');f.method='post';f.action='${origin}/save';f.enctype='multipart/form-data';for(const[n,v]of[['url',location.href],['html',document.documentElement.outerHTML]]){const i=document.createElement('input');i.type='hidden';i.name=n;i.value=v;f.append(i)}document.body.append(f);f.submit();f.remove()})()`

/** Undo starts a new persisted change; closing a toast never owns a write. */
function offerUndo(title: string, undo: () => void | Promise<void>) {
  const id = toastManager.add({
    title,
    actionProps: {
      children: "Undo",
      onClick: () => {
        void undo()
        toastManager.close(id)
      },
    },
  })
}

/** A file's SHA-256, which the bucket checks the upload against, read 16 MB at
 *  a time: Web Crypto hashes only bytes held all at once, and a recording can
 *  be gigabytes. */
async function sha256(file: File): Promise<string> {
  const PART = 16 * 1024 * 1024
  const hash = await createSHA256()
  for (let at = 0; at < file.size; at += PART) hash.update(new Uint8Array(await file.slice(at, at + PART).arrayBuffer()))
  return hash.digest("hex")
}
