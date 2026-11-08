/**
 * Where the library's files are kept: in a bucket of its own, each at its
 * article's id and the SHA-256 of its bytes, which the bucket checks what is
 * sent to it against, so a key never names other bytes. Files are only added
 * while their article is kept, and go with it.
 *
 * A file the browser uploads, hashed there, waits under uploads/ until it is
 * saved, then is copied to its article's; one never saved expires in a day.
 * The browser reads an original from the bucket itself, at an address signed
 * for it, by ranges as a player asks. The server reads a file whole, but one
 * over MAX_BYTES, as only a recording may be: of that, only its first bytes,
 * which say what it is.
 * Server-only.
 */
import { createHash, randomUUID } from "node:crypto"
import type { IncomingMessage } from "node:http"
import { Agent, request } from "node:https"
import { pipeline } from "node:stream/promises"
import { setTimeout as sleep } from "node:timers/promises"
import { AwsClient } from "aws4fetch"
import { ImportError, MAX_BYTES } from "@/lib/files"

/** The most the bucket takes in one upload, as the browser sends a file. */
export const MAX_UPLOAD = 5 * 1024 * 1024 * 1024

/** As much of a file too large to read whole as says what it is. */
const HEAD = 64 * 1024

/** The bucket's path-style address without a trailing slash, as its provider
 *  gives it: R2's EU jurisdiction answers only at its own endpoint,
 *  https://<account>.eu.r2.cloudflarestorage.com/<bucket> */
const BUCKET = process.env.STORAGE_URL
const at = (key: string) => `${BUCKET}/${key}`

let client: AwsClient | undefined
function bucket(): AwsClient {
  if (!BUCKET) throw new Error("Set STORAGE_URL to the bucket's address")
  return client ??= new AwsClient({
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID!,
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY!,
    // Unset, it is read off the address for R2.
    region: process.env.STORAGE_REGION,
    service: "s3",
  })
}

type Sent = { method?: string; headers?: Record<string, string>; body?: Uint8Array | string | Iterable<Uint8Array> | AsyncIterable<Uint8Array> }

const REQUEST_TIMEOUT = 30_000
// Reuse R2's TLS connections across ordinary pauses between opening articles.
const connections = new Agent({ keepAlive: true, maxFreeSockets: 8, timeout: 60_000 })
const TRANSIENT = new Set(["InternalError", "SlowDown", "ServiceUnavailable", "RequestTimeout", "TooManyRequests"])

class BucketError extends Error {
  constructor(readonly status: number, what: string, readonly code?: string) {
    super(`The bucket answered ${status}${code ? ` (${code})` : ""} ${what}`)
  }
}

/** Read operation/error XML to completion, retaining only enough for its
 *  error code. CopyObject and DeleteObjects can fail inside a 200 response. */
async function operation(answer: IncomingMessage): Promise<string> {
  const parts: Buffer[] = []
  let kept = 0
  for await (const part of answer) {
    if (kept < HEAD) {
      const bytes = Buffer.from(part).subarray(0, HEAD - kept)
      parts.push(bytes)
      kept += bytes.length
    }
  }
  return Buffer.concat(parts).toString("utf8")
}

/** The bucket's answer, its body a part at a time. A request that got none,
 *  as when a connection drops, or an answer of 429 or 5xx, is tried again after a
 *  second, then two, unless its body came a part at a time, which is gone once
 *  sent. By node:https, not fetch, which Next wraps to share and cache what it
 *  answers, keeping a copy: of a file of gigabytes, every byte. */
async function send(url: string, what: string, { body, ...sent }: Sent = {}, complete = false): Promise<IncomingMessage> {
  // Signed without its body, which the bucket is told isn't signed: signing
  // makes a Request of what it signs, which would copy the body.
  const inParts = typeof body === "object" && !(body instanceof Uint8Array)
  for (let attempt = 1; ; attempt++) {
    const signed = await bucket().sign(url, sent)
    let failure: Error
    try {
      const answer = await new Promise<IncomingMessage>((resolve, reject) => {
        const sending = request(signed.url, {
          agent: connections, method: signed.method, headers: Object.fromEntries(signed.headers), timeout: REQUEST_TIMEOUT,
        }, answer => {
          // A disconnect can arrive before the awaiting caller starts reading.
          answer.on("error", () => {})
          resolve(answer)
        })
        const timeout = () => sending.destroy(new Error("The bucket request timed out"))
        // Socket inactivity covers uploads and response bodies; this separate
        // timer also bounds DNS lookup and establishing the TLS connection.
        const connecting = setTimeout(timeout, REQUEST_TIMEOUT)
        connecting.unref()
        sending.once("socket", socket => {
          if (socket.connecting) socket.once("secureConnect", () => clearTimeout(connecting))
          else clearTimeout(connecting)
        })
        sending.on("timeout", timeout).on("error", reject).once("close", () => clearTimeout(connecting))
        if (inParts) pipeline(body, sending).catch(reject)
        else if (body instanceof Uint8Array) {
          // Node counts a write as activity on the socket only once all of it
          // is sent, and a large file written whole over a slow link outlasts
          // the inactivity timeout before it is: so a megabyte at a time.
          sending.setHeader("content-length", body.length)
          pipeline(megabytes(body), sending).catch(reject)
        } else sending.end(body)
      })
      const status = answer.statusCode ?? 0
      if (status >= 200 && status < 300 && !complete) return answer
      const xml = await operation(answer)
      if (status >= 200 && status < 300 && !/<Error(?:\s|>)/.test(xml)) return answer
      const code = /<Code>([A-Za-z0-9]+)<\/Code>/.exec(xml)?.[1]
      failure = new BucketError(status, what, code)
    } catch (cause) {
      failure = new Error(`The bucket couldn't be reached ${what}`, { cause })
    }
    const retry = !(failure instanceof BucketError) || failure.status === 429 || failure.status >= 500 ||
      (failure.code !== undefined && TRANSIENT.has(failure.code))
    if (attempt === 3 || inParts || !retry) throw failure
    await sleep(attempt * 1000)
  }
}

function* megabytes(bytes: Uint8Array): Generator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += 1 << 20) yield bytes.subarray(at, at + (1 << 20))
}

/** A request whose answer only says it was done. */
async function act(url: string, what: string, sent: Sent): Promise<void> {
  await send(url, what, sent, true)
}

/** An address the browser can send a request to without the keys, for as
 *  long as given, with these headers only. */
async function presign(url: URL, seconds: number, method = "GET", headers?: Record<string, string>): Promise<string> {
  url.searchParams.set("X-Amz-Expires", String(seconds))
  return (await bucket().sign(url, { method, headers, aws: { signQuery: true } })).url
}

/** What the bucket sent: all of it, or, of a file over MAX_BYTES, its first HEAD bytes. */
async function read(answer: IncomingMessage): Promise<Uint8Array> {
  const whole = Number(answer.headers["content-length"] ?? 0) <= MAX_BYTES
  const parts: Buffer[] = []
  let kept = 0
  for await (const part of answer) {
    parts.push(part)
    kept += part.length
    if (!whole && kept >= HEAD) break
  }
  return Buffer.concat(parts).subarray(0, whole ? undefined : HEAD)
}

/** At most this many files go to or come from the bucket at once: an
 *  article's pictures, all at once, would open a connection each, and over a
 *  slow link many would time out. The rest wait their turn. */
function transfers(limit: number) {
  let moving = 0
  const waiting: (() => void)[] = []
  return async <T>(transfer: () => Promise<T>): Promise<T> => {
    if (moving < limit) moving++
    else await new Promise<void>((resolve) => waiting.push(resolve))
    try {
      return await transfer()
    } finally {
      // The turn passes to the next in line, if there is one.
      const next = waiting.shift()
      if (next) next()
      else moving--
    }
  }
}

const inTurn = transfers(6)
// Opening an article must not wait behind books being imported or reread.
const inView = transfers(2)

// Share only writes still in progress; completed objects are not cached here.
const putting = new Map<string, Promise<void>>()

/** Keep bytes with an article, unless already known to be kept with it. */
export async function put(article: number, bytes: Uint8Array, kept?: ReadonlySet<string>): Promise<string> {
  const digest = createHash("sha256").update(bytes).digest()
  const hash = digest.toString("hex")
  if (kept?.has(hash)) return hash
  const key = at(`${article}/${hash}`)
  let saving = putting.get(key)
  if (!saving) {
    saving = inTurn(() => act(key, `keeping ${hash}`, {
      method: "PUT",
      body: bytes,
      headers: { "x-amz-checksum-sha256": digest.toString("base64") },
    })).finally(() => putting.delete(key))
    putting.set(key, saving)
  }
  await saving
  return hash
}

/** Keep bytes with an article as they come, as many as given, by the hash
 *  given for them, which the bucket checks them against: a file restored from
 *  an archive, which a recording too large to hold can be. */
export async function putParts(article: number, hash: string, size: number, parts: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<void> {
  await act(at(`${article}/${hash}`), `keeping ${hash}`, {
    method: "PUT",
    body: parts,
    headers: { "content-length": String(size), "x-amz-checksum-sha256": Buffer.from(hash, "hex").toString("base64") },
  })
}

/** A kept file's bytes: all of them, or, of one over MAX_BYTES, its first. */
export async function get(article: number, hash: string, interactive = false): Promise<Uint8Array> {
  return (interactive ? inView : inTurn)(async () => read(await send(at(`${article}/${hash}`), `reading ${hash}`)))
}

/** A kept file a part at a time, however large it is. */
export const stream = (article: number, hash: string): Promise<AsyncIterable<Uint8Array>> =>
  send(at(`${article}/${hash}`), `reading ${hash}`)

/** An address the browser can read a kept file at, sent with this type and
 *  disposition, for a week, the longest a signature lasts, so a recording
 *  plays on however long its page is open. */
export async function address(article: number, hash: string, type: string, disposition: string): Promise<string> {
  const url = new URL(at(`${article}/${hash}`))
  url.searchParams.set("response-content-type", type)
  url.searchParams.set("response-content-disposition", disposition)
  return presign(url, 7 * 24 * 60 * 60)
}

/** Every file kept with these articles, gone with them: listed a thousand
 *  at a time, the most one request deletes, until none are left. */
export async function removeArticles(ids: number[]): Promise<void> {
  for (const id of ids) {
    for (;;) {
      const query = new URLSearchParams({ "list-type": "2", prefix: `${id}/` })
      const listed = new TextDecoder().decode(await read(await send(`${BUCKET}?${query}`, `listing article ${id}`)))
      const keys = Array.from(listed.matchAll(/<Key>(.*?)<\/Key>/g), ([, key]) => key)
      if (!keys.length) break
      const body = `<Delete><Quiet>true</Quiet>${keys.map((key) => `<Object><Key>${key}</Key></Object>`).join("")}</Delete>`
      await act(`${BUCKET}?delete`, `deleting article ${id}`, {
        method: "POST",
        body,
        headers: { "content-md5": createHash("md5").update(body).digest("base64") },
      })
    }
  }
}

const UPLOAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** An address the browser can PUT a file to for the next hour, sent with the
 *  checksum given, the base64 of the SHA-256 the browser hashed it to, which
 *  the bucket checks it against; and the name it is saved by after (see takeUpload). */
export async function uploadTarget(hash: string): Promise<{ upload: string; url: string; checksum: string }> {
  const upload = randomUUID()
  const checksum = Buffer.from(hash, "hex").toString("base64")
  return { upload, checksum, url: await presign(new URL(at(`uploads/${upload}`)), 60 * 60, "PUT", { "x-amz-checksum-sha256": checksum }) }
}

/** A file the browser uploaded, by the SHA-256 the bucket checked it against. */
export type Upload = { upload: string; hash: string }

/** A file the browser uploaded, read as a kept file is, and its hash, which the
 *  bucket keeps with it: a recording too large to read whole is never downloaded. */
export async function takeUpload(upload: string): Promise<{ bytes: Uint8Array; whole: boolean; upload: Upload }> {
  if (!UPLOAD.test(upload)) throw new ImportError("That upload didn't arrive")
  return inTurn(async () => {
    // GET returns the checksum and size with the bytes. read() stops after
    // the first bytes of a large recording, without a separate HEAD request.
    const found = await send(at(`uploads/${upload}`), "reading an upload", { headers: { "x-amz-checksum-mode": "ENABLED" } }).catch(error => {
      if (error instanceof BucketError && error.status === 404) return null
      throw error
    })
    const checksum = found?.headers["x-amz-checksum-sha256"]
    if (!found || typeof checksum !== "string") {
      found?.destroy()
      throw new ImportError("That upload didn't arrive")
    }
    const whole = Number(found.headers["content-length"]) <= MAX_BYTES
    const bytes = await read(found)
    return { bytes, whole, upload: { upload, hash: Buffer.from(checksum, "base64").toString("hex") } }
  })
}

/** Some of an upload's bytes, as a range gives them: `${first}-${last}`, or
 *  `-${count}`, its last. */
export const uploadBytes = (upload: string, range: string): Promise<Uint8Array> =>
  inTurn(async () => read(await send(at(`uploads/${upload}`), "reading an upload", { headers: { range: `bytes=${range}` } })))

/** An upload's bytes from first to last, a part at a time, however many. */
export const uploadParts = (upload: string, first: number, last: number): Promise<AsyncIterable<Uint8Array>> =>
  send(at(`uploads/${upload}`), "reading an upload", { headers: { range: `bytes=${first}-${last}` } })

/** An upload kept with an article, copied within the bucket; the hash that names it. */
export async function keepUpload(article: number, { upload, hash }: Upload): Promise<string> {
  await act(at(`${article}/${hash}`), `keeping ${hash}`, {
    method: "PUT",
    headers: { "x-amz-copy-source": `${new URL(BUCKET!).pathname}/uploads/${upload}` },
  })
  return hash
}

/** An upload gone from the bucket, whatever saving it came to. */
export async function removeUpload(upload: string): Promise<void> {
  if (UPLOAD.test(upload)) await act(at(`uploads/${upload}`), "removing an upload", { method: "DELETE" }).catch(() => {})
}
