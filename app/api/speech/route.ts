/** A sentence in; audio and word timestamps out. Kokoro is served locally,
 * while cloud voices use CARTESIA_API_KEY. */

import { readBytes } from "@/lib/files"

const KOKORO = process.env.KOKORO_URL || "http://127.0.0.1:8880/dev/captioned_speech"
const KOKORO_VOICE = /^[a-z]{2}_[a-z]+$/
const CARTESIA = "https://api.cartesia.ai/tts/sse"
const CARTESIA_VOICE = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/
/** Cartesia's samples a second, each 16 bits, in one channel. */
const SAMPLE_RATE = 24_000

/** Longer than any sentence, short of keeping the voice busy for minutes. */
const MAX_TEXT = 5_000

export async function POST(request: Request) {
  const input = await readBytes(request, 64 * 1024).then(bytes => JSON.parse(Buffer.from(bytes).toString())).catch(() => null)
  const { text, voice } = input ?? {}
  const sentence = typeof text === "string" && text.trim() && text.length <= MAX_TEXT
  const say = typeof voice === "string" && (KOKORO_VOICE.test(voice) ? kokoro : CARTESIA_VOICE.test(voice) ? cartesia : null)
  if (!sentence || !say) return Response.json({ error: "Send a sentence and a voice" }, { status: 400 })
  try {
    return await say(text, voice)
  } catch {
    return Response.json({ error: "The voice service returned an invalid or incomplete response. Try again." }, { status: 502 })
  }
}

async function kokoro(text: string, voice: string) {
  const spoken = await fetch(KOKORO, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ input: text, voice, response_format: "mp3", stream: false }),
  }).catch(() => null)
  if (!spoken) {
    return Response.json({ error: "The local voice is unavailable. Start your speech service or choose a cloud voice." }, { status: 503 })
  }
  if (!spoken.ok) return Response.json({ error: `Kokoro answered ${spoken.status}` }, { status: 502 })
  const { audio, timestamps } = JSON.parse(Buffer.from(await readBytes(spoken)).toString())
  if (typeof audio !== "string" || !audio.length || (timestamps !== undefined && !Array.isArray(timestamps))) {
    throw new Error("Invalid speech response")
  }
  return Response.json({ audio: `data:audio/mpeg;base64,${audio}`, words: timestamps ?? [] })
}

/** Cartesia answers in server-sent events: pieces of the audio, raw samples
 *  only, and the words said so far, each with the second it starts. */
async function cartesia(text: string, voice: string) {
  const key = process.env.CARTESIA_API_KEY
  if (!key) return Response.json({ error: "Cloud voices are not configured. Choose a local voice." }, { status: 503 })
  const spoken = await fetch(CARTESIA, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "cartesia-version": "2026-08-14", "content-type": "application/json" },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      // A dated snapshot: plain sonic-3.6 moves to each new one, and its voice with it.
      model_id: "sonic-3.6-2026-08-27",
      transcript: text,
      voice: { id: voice },
      language: "en",
      output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: SAMPLE_RATE },
      add_timestamps: true,
      // Words as written ("1990,"), not as said, so the player finds them in the page.
      use_normalized_timestamps: false,
    }),
  }).catch(() => null)
  if (!spoken) return Response.json({ error: "Cartesia can't be reached" }, { status: 503 })
  if (!spoken.ok) return Response.json({ error: `Cartesia answered ${spoken.status}` }, { status: 502 })

  const samples: Buffer[] = []
  const words: { word: string; start_time: number }[] = []
  for (const line of Buffer.from(await readBytes(spoken)).toString().split("\n")) {
    if (!line.startsWith("data:")) continue
    const event = JSON.parse(line.slice(5))
    if (event.type === "error") return Response.json({ error: `Cartesia: ${event.message}` }, { status: 502 })
    if (event.type === "chunk") samples.push(Buffer.from(event.data, "base64"))
    if (event.type === "timestamps") {
      const { words: said, start } = event.word_timestamps
      words.push(...said.map((word: string, i: number) => ({ word, start_time: start[i] })))
    }
  }
  if (!samples.length) throw new Error("No audio returned")
  return Response.json({ audio: `data:audio/wav;base64,${wav(Buffer.concat(samples)).toString("base64")}`, words })
}

/** Raw samples as a WAV file, which a browser plays: behind the 44-byte header
 *  RIFF gives 16-bit mono PCM. */
function wav(samples: Buffer) {
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + samples.length, 4)
  header.write("WAVEfmt ", 8)
  header.writeUInt32LE(16, 16) // the format's length
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // channels
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * 2, 28) // bytes a second
  header.writeUInt16LE(2, 32) // bytes a sample
  header.writeUInt16LE(16, 34) // bits a sample
  header.write("data", 36)
  header.writeUInt32LE(samples.length, 40)
  return Buffer.concat([header, samples])
}
