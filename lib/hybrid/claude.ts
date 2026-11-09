/** The frontier model the cloud half calls on, when ANTHROPIC_API_KEY is set. */
import Anthropic from "@anthropic-ai/sdk"
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod"
import type { z } from "zod"

export const MODEL = "claude-opus-5-5"

let client: Anthropic | undefined
export const configured = () => Boolean(process.env.ANTHROPIC_API_KEY)

/** One structured answer, checked against its schema; null if the model
 *  declined or the answer didn't parse. */
export async function ask<T extends z.ZodType>(
  schema: T, system: string, prompt: string, effort: "low" | "medium" | "high" = "low",
): Promise<z.infer<T> | null> {
  client ??= new Anthropic()
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    // On a policy decline the API reruns the request on a fallback model itself.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort, format: betaZodOutputFormat(schema) },
    system,
    messages: [{ role: "user", content: prompt }],
  })
  if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") return null
  return response.parsed_output ?? null
}
