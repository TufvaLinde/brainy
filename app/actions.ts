"use server"

/**
 * Everything the browser can ask of the server. The library's changes refresh
 * the page they were made on, so what it lists is always the database's.
 */

import { refresh } from "next/cache"
import { redirect } from "next/navigation"
import * as library from "@/lib/library"
import * as db from "@/lib/db"
import type { Location } from "@/lib/db"
import { ImportError } from "@/lib/files"
import type { Quote } from "@/lib/highlights"
import { MAX_UPLOAD, uploadTarget } from "@/lib/storage"

/** The library's one field: links, one or many, are saved; anything else is
 *  searched for. */
export async function submit(form: FormData) {
  const text = String(form.get("q") ?? "").trim()
  const links = text.split(/\s+/).filter(library.isLink)
  if (!links.length) redirect(text ? `/?${new URLSearchParams({ q: text })}` : "/")
  await library.addLinks(links.map((url) => ({ url })))
  redirect("/")
}

/** Where the browser can send each of the files it holds, by their sizes and
 *  the SHA-256 it hashed each to, straight to the bucket, as a function takes
 *  no body over 4.5 MB; or why they can't be sent. */
export async function uploadTargets(files: { size: number; hash: string }[]): Promise<
  { error: string } | { targets: { upload: string; url: string; checksum: string }[] }
> {
  if (files.length > 20) return { error: "Upload at most 20 files at a time" }
  if (files.some(({ size }) => size > MAX_UPLOAD)) return { error: "A file can be at most 5 GB" }
  if (files.some(({ hash }) => !/^[0-9a-f]{64}$/.test(hash))) return { error: "That file wasn't hashed" }
  return { targets: await Promise.all(files.map(({ hash }) => uploadTarget(hash))) }
}

/** The files the browser sent to the bucket, saved; then where to go: to
 *  what was saved, or the library, if that was several files or a list of
 *  links, or with the reasons any couldn't be read. */
export async function saveUploads(uploads: { upload: string; name: string; type: string }[]): Promise<string> {
  const saved: (number | null)[] = []
  const failed: string[] = []
  for (const { upload, name, type } of uploads) {
    try {
      saved.push(await library.saveFile(upload, name, type))
    } catch (error) {
      if (!(error instanceof ImportError)) throw error
      failed.push(`${name}: ${error.message}`)
    }
  }
  if (failed.length) return `/?${new URLSearchParams({ error: failed.join(" · ") })}`
  return saved.length === 1 && saved[0] !== null ? `/read/${saved[0]}` : "/"
}

export async function move(ids: number[], location: Location) {
  await db.moveArticles(ids, location)
  refresh()
}

export async function retry(id: number) {
  await db.retry(id)
  refresh()
}

export async function unsubscribe(url: string) {
  await db.unsubscribe(url)
  refresh()
}

export async function emptyTrash() {
  await db.emptyTrash()
  refresh()
}

/** An article moved from its reading view, which goes back to the library. */
export async function moveAndReturn(id: number, location: Location) {
  await db.moveArticles([id], location)
  redirect("/")
}

export async function setListened(id: number, block: number) {
  await db.setListened(id, block)
}

export async function addHighlight(articleId: number, quote: Quote) {
  return db.saveHighlight(articleId, quote)
}

export async function setNote(id: number, note: string) {
  await db.setNote(id, note)
}

export async function setArticleNote(id: number, note: string) {
  await db.setArticleNote(id, note)
}

export async function removeHighlight(id: number) {
  await db.removeHighlight(id)
}
