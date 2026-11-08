"use client"

import { Check, Copy, Highlighter, NotebookPen, Trash2 } from "lucide-react"
import { useEffect, useEffectEvent, useRef, useState } from "react"
import { addHighlight, removeHighlight, setArticleNote, setNote } from "@/app/actions"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent } from "@/components/ui/popover"
import { Textarea } from "@/components/ui/textarea"
import { toastManager } from "@/components/ui/toast"
import { articleElement, mark, rangeOf, textOfPage, type PageText } from "@/lib/dom"
import { anchor, highlightsMarkdown, quoteOf, type Highlight, type Quote } from "@/lib/highlights"
import { useKeys } from "@/hooks/use-keys"

/** What a popover is about, anchored to its text: a selection to keep, or a highlight to write a note on. */
type Menu = { anchor: Range; quote?: Quote; highlight?: Highlight; text?: string }

const inReadingOrder = (a: Highlight, b: Highlight) => a.position - b.position

/** Select text in the article to Highlight it, write a Note on it or Copy it;
 *  or press h, which highlights the selection or, while the voice reads, the
 *  sentence being read, or n, which writes a note on it too. A highlight
 *  clicked opens its note. All are listed in the notebook, under a note on the
 *  whole article: beside the column on a wide screen, no wider than the margin
 *  the column leaves, after the article on a narrower one; one whose words the
 *  article no longer holds is listed, but marks nothing. */
export function Highlights({ id, title, url, highlights, articleNote }: {
  id: number; title: string; url: string; highlights: Highlight[]; articleNote: string
}) {
  const [list, setList] = useState(highlights)
  // Kept as its popover closes, so the popover fades out whole.
  const [menu, setMenu] = useState<Menu | null>(null)
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const note = useRef<HTMLTextAreaElement>(null)
  // A ref as well as state, as a second click can come before the state is drawn.
  const saving = useRef(false)
  const [pending, setPending] = useState(false)
  const failed = () => toastManager.add({ title: "Could not save that change. Please try again.", type: "error" })
  // Read from the page once it is drawn; the article never changes while open.
  const page = useRef<PageText | null>(null)
  const pageText = () => (page.current ??= textOfPage(articleElement()))

  /** Where a highlight starts in the text, if its words are there to find. */
  const startOf = (h: Highlight) => anchor(h, pageText().text)
  const placeOf = (h: Highlight): Range | null => {
    const start = startOf(h)
    return start === null ? null : pageText().range(start, start + h.quote.length)
  }

  const draw = useEffectEvent((highlights: Highlight[]) => mark("highlights", highlights.flatMap((h) => placeOf(h) ?? [])))
  useEffect(() => {
    draw(list)
    return () => mark("highlights", [])
  }, [list])

  /** A range of the article as a quote of its text, without the space at its ends. */
  const quoteOfRange = (range: Range): Quote | null => {
    const article = articleElement()
    if (!article.contains(range.startContainer)) return null
    const { text, indexOf } = pageText()
    let start = indexOf(range.startContainer, range.startOffset)
    let end = article.contains(range.endContainer) ? indexOf(range.endContainer, range.endOffset) : text.length
    while (start < end && text[start] === " ") start++
    while (end > start && text[end - 1] === " ") end--
    return start < end ? quoteOf(text, start, end) : null
  }

  const keep = async (quote: Quote) => {
    getSelection()?.removeAllRanges()
    try {
      const kept = await addHighlight(id, quote)
      setList((l) => (l.some((h) => h.id === kept.id) ? l : [...l, kept].sort(inReadingOrder)))
      return kept
    } catch { failed(); return null }
  }

  const show = (next: Menu) => {
    setMenu(next)
    setOpen(true)
  }

  const highlight = (quote: Quote) => {
    setOpen(false)
    void keep(quote)
  }

  const openNote = (h: Highlight) => show({ anchor: placeOf(h) ?? rangeOf(articleElement(), 0, 0), highlight: h })
  const writeNote = (quote: Quote) => void keep(quote).then((h) => h && openNote(h))

  /** Make a change to the note's highlight, one at a time, and close the
   *  note; or, if it fails, say so and leave it open. */
  const change = async (save: () => Promise<void>) => {
    if (saving.current) return
    saving.current = true
    setPending(true)
    try {
      await save()
      setOpen(false)
    } catch {
      failed()
    } finally {
      saving.current = false
      setPending(false)
    }
  }

  /** Close the note, keeping it if it was changed. */
  const closeNote = () =>
    change(async () => {
      const h = menu?.highlight
      const written = note.current?.value.trim()
      if (!h || written === undefined || written === h.note) return
      await setNote(h.id, written)
      setList((l) => l.map((x) => (x.id === h.id ? { ...x, note: written } : x)))
    })

  const drop = (h: Highlight) =>
    change(async () => {
      await removeHighlight(h.id)
      setList((l) => l.filter((x) => x.id !== h.id))
    })

  /** Offer to keep the selection, if there is one; false if there is none. */
  const offerSelection = useEffectEvent((): boolean => {
    const selection = getSelection()
    if (!selection || selection.isCollapsed) return false
    const range = selection.getRangeAt(0).cloneRange()
    const quote = quoteOfRange(range)
    if (quote) show({ anchor: range, quote, text: selection.toString() })
    return true
  })

  const onMouseUp = useEffectEvent((e: MouseEvent) => {
    if (offerSelection()) return
    const caret = document.caretPositionFromPoint?.(e.clientX, e.clientY)
    if (!caret || !articleElement().contains(caret.offsetNode)) return
    const at = pageText().indexOf(caret.offsetNode, caret.offset)
    const hit = list.find((h) => {
      const start = startOf(h)
      return start !== null && start <= at && at < start + h.quote.length
    })
    if (hit) openNote(hit)
  })

  useEffect(() => {
    const article = articleElement()
    // A finger selects by holding, then dragging the handles, and no mouseup
    // follows: the selection is offered once it has rested a moment.
    let touching = false
    let resting = 0
    const onPointerDown = (e: PointerEvent) => { touching = e.pointerType !== "mouse" }
    const onSelectionChange = () => {
      if (!touching) return
      clearTimeout(resting)
      resting = window.setTimeout(offerSelection, 400)
    }
    article.addEventListener("mouseup", onMouseUp)
    addEventListener("pointerdown", onPointerDown)
    document.addEventListener("selectionchange", onSelectionChange)
    return () => {
      clearTimeout(resting)
      article.removeEventListener("mouseup", onMouseUp)
      removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("selectionchange", onSelectionChange)
    }
  }, [])

  /** The selection or, if there is none, the sentence the voice is reading. */
  const quoteForKeys = () => {
    const selection = getSelection()
    const range =
      selection?.isCollapsed === false
        ? selection.getRangeAt(0)
        : ([...(CSS.highlights?.get("speaking-sentence") ?? [])][0] as Range | undefined)
    return range && quoteOfRange(range)
  }
  useKeys({
    h: () => {
      const quote = quoteForKeys()
      if (quote) highlight(quote)
    },
    n: () => {
      const quote = quoteForKeys()
      if (quote) writeNote(quote)
    },
  })

  // What the server keeps: a note that failed to save stays in its box, to be saved as it is left again.
  const savedNote = useRef(articleNote)
  const saveArticleNote = async (written: string) => {
    if (written === savedNote.current) return
    try { await setArticleNote(id, written); savedNote.current = written } catch { failed() }
  }

  const copyMarkdown = async () => {
    const markdown = [`# ${title}`, url, savedNote.current, highlightsMarkdown(list)].filter(Boolean).join("\n\n")
    try { await navigator.clipboard.writeText(markdown) } catch { failed(); return }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <>
      {/* The toolbar leaves the focus in the article, so h and the selection both survive. */}
      <Popover open={open && !!menu?.quote} onOpenChange={(opened) => !opened && setOpen(false)}>
        <PopoverContent anchor={menu?.anchor} initialFocus={false} tooltipStyle>
          <div className="flex gap-0.5">
            <Button variant="ghost" size="sm" onClick={() => highlight(menu!.quote!)}>
              <Highlighter />
              Highlight
            </Button>
            <Button variant="ghost" size="sm" onClick={() => writeNote(menu!.quote!)}>
              <NotebookPen />
              Note
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(menu!.text ?? menu!.quote!.quote).catch(failed)
                setOpen(false)
              }}
            >
              <Copy />
              Copy
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <Popover open={open && !!menu?.highlight} onOpenChange={(opened) => !opened && closeNote()}>
        <PopoverContent anchor={menu?.anchor} className="w-80">
          {menu?.highlight && (
            <div className="grid gap-3">
              <Textarea
                key={menu.highlight.id}
                ref={note}
                defaultValue={menu.highlight.note}
                placeholder="Write a note"
                aria-label="Highlight note"
                disabled={pending}
              />
              <div className="flex justify-between">
                <Button variant="ghost" size="sm" disabled={pending} onClick={() => void drop(menu.highlight!)}>
                  <Trash2 />
                  Delete
                </Button>
                <Button size="sm" disabled={pending} onClick={() => void closeNote()}>
                  Done
                </Button>
              </div>
            </div>
          )}
        </PopoverContent>
      </Popover>

      <aside className="mt-16 border-t pt-8 2xl:fixed 2xl:top-24 2xl:right-8 2xl:mt-0 2xl:max-h-[calc(100vh-8rem)] 2xl:w-[min(18rem,calc(50vw-var(--column)/2-3rem))] 2xl:overflow-y-auto 2xl:border-0 2xl:pt-0">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Notebook</h2>
          <Button variant="ghost" size="sm" onClick={copyMarkdown} className="text-muted-foreground">
            {copied ? <Check /> : <Copy />}
            {copied ? "Copied" : "Copy as Markdown"}
          </Button>
        </div>
        <Textarea
          defaultValue={articleNote}
          placeholder="Write a note on this article"
          aria-label="Note on this article"
          className="mt-4"
          onBlur={(e) => void saveArticleNote(e.currentTarget.value.trim())}
        />
        <ul className="mt-5 grid gap-5">
          {list.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                className="line-clamp-4 border-yellow-400 border-l-2 pl-3 text-left"
                onClick={() => openNote(h)}
              >
                {h.quote}
              </button>
              {h.note && <p className="mt-1 pl-3.5 text-muted-foreground">{h.note}</p>}
            </li>
          ))}
        </ul>
      </aside>
    </>
  )
}
