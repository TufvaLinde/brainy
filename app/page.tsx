import { after } from "next/server"
import { Library } from "@/components/library"
import { FILE_ACCEPT } from "@/lib/formats"
import { processPending } from "@/lib/library"
import { LOCATIONS, listArticles, listFeeds, search } from "@/lib/db"

/** How many cards a list shows at first, and how many more each "Show more" adds. */
const PAGE = 50

/** A location's articles, ?in=feed, ?in=later, ?in=archive or ?in=trash, the inbox by default; or
 *  with ?q=, what matches it wherever it is; ?shown= lists that many, PAGE at
 *  least; ?error= says why something sent to be saved couldn't be. Once the
 *  page is sent, what is waiting is read: feeds due a check, links saved but
 *  not yet fetched, which the library asks again for until they are, and
 *  articles read by older rules (see lib/library). */
export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ in?: string; q?: string; shown?: string; error?: string }>
}) {
  const { in: place, q = "", shown, error } = await searchParams
  const location = LOCATIONS.find((l) => l === place) ?? "inbox"
  const query = q.trim()
  const limit = Math.max(PAGE, Number.parseInt(shown ?? "") || 0)
  // One past the limit tells whether there are more.
  const found = query ? await search(query, limit + 1) : await listArticles(location, limit + 1)
  const list: Record<string, string> = query ? { q: query } : location === "inbox" ? {} : { in: location }
  const more = found.length > limit ? `/?${new URLSearchParams({ ...list, shown: String(limit + PAGE) })}` : null
  const feeds = !query && location === "feed" ? (await listFeeds()).map((feed) => feed.url) : []
  after(processPending)

  return (
    <Library
      // A fresh one for each list: what it hid is about the cards it showed.
      key={query || location}
      cards={found.slice(0, limit)}
      more={more}
      location={query ? null : location}
      query={query}
      error={error}
      accept={FILE_ACCEPT}
      feeds={feeds}
    />
  )
}
