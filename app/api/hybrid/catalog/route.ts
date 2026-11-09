import { after } from "next/server"
import { maybeRelabel } from "@/lib/hybrid/agent"
import { configured, MODEL } from "@/lib/hybrid/claude"
import { labelPending, upgradeLabels } from "@/lib/hybrid/labeller"
import { catalog, profile } from "@/lib/hybrid/store"

// Labelling continues after the answer is sent, which a model takes time over.
export const maxDuration = 300

/** Everything the device keeps offline: the library, what the agent made of
 *  each item, and the sphere it last drew. Items not labelled yet are
 *  labelled once this is sent, and fetched again by the device's next sync. */
export async function GET() {
  const current = await profile()
  const items = await catalog(current)
  after(async () => {
    await upgradeLabels()
    if (await labelPending()) await maybeRelabel(current.version === 0)
  })
  return Response.json({
    items, profile: current,
    cloud: { model: configured() ? MODEL : null, unlabeled: items.filter(i => !i.labels).length },
  })
}
