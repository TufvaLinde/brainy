import { Download, ExternalLink } from "lucide-react"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Highlights } from "@/components/highlights"
import { Triage } from "@/components/library"
import { Contents, Notes } from "@/components/navigation"
import { Player } from "@/components/player"
import { Progress } from "@/components/progress"
import { Button } from "@/components/ui/button"
import { getArticle } from "@/lib/db"
import { ARTICLE_ID } from "@/lib/dom"
import { contentsOf } from "@/lib/markdown"

/** One article, rendered from its Markdown: opened where it was left, read
 *  aloud on request, and marked up as it is read. Its contents, as a book's
 *  chapters are, and its original, the page it came from or the file as it
 *  was imported, are a click away, and a book's notes open where they are
 *  marked; a PDF's pages can be read in place of its text, and are, if it has
 *  none; a recording plays. */
export default async function ReadPage({ params, searchParams }: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ view?: string }>
}) {
  const { id } = await params
  // Nine digits at most, which an integer column always holds.
  const article = /^\d{1,9}$/.test(id) ? await getArticle(Number(id), "html") : null
  if (!article || (article.reading === null && !article.format)) notFound()
  const original = article.format ? `/read/${article.id}/original` : /^https?:/.test(article.url) ? article.url : null
  const pdf = article.format === "PDF"
  const originalView = pdf && ((await searchParams).view === "original" || !article.reading)
  const played = /^(?:audio|video)(?=\/)/.exec(article.type ?? "")?.[0]
  const about = [
    article.byline,
    article.publishedAt?.toLocaleDateString("en", { dateStyle: "medium" }),
    article.reading ? `${article.minutes}\u00a0min` : null,
  ]

  return (
    <article>
      <header className="mt-6 mb-10">
        <h1 dir="auto" className="text-balance font-article font-semibold text-3xl leading-tight tracking-tight">
          {article.title}
        </h1>
        <div className="mt-3 flex items-center justify-between gap-4 text-muted-foreground text-sm">
          <p>
            {/^https?:/.test(article.url) ? (
              <a href={article.url} className="hover:text-foreground">
                {article.site}
              </a>
            ) : (
              article.site
            )}
            {about.filter(Boolean).map((part) => ` · ${part}`)}
          </p>
          <Triage id={article.id} location={article.location} />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {article.reading && !originalView && <Contents entries={contentsOf(article.reading)} title={article.title} byline={article.byline} cover={article.format ? article.image : null} />}
          {original && (
            <Button render={<a href={original} target="_blank" rel="noopener noreferrer" />} variant="outline" size="sm">
              <ExternalLink /> Open original{article.format ? ` · ${article.format}` : ""}
            </Button>
          )}
          {pdf && article.reading && (
            <Button render={<Link href={originalView ? `/read/${id}` : `/read/${id}?view=original`} />} variant="ghost" size="sm">
              {originalView ? "Text view" : "PDF view"}
            </Button>
          )}
          {article.reading && (
            <Button render={<a href={`/read/${id}/original?format=markdown`} />} variant="ghost" size="sm">
              <Download /> Download Markdown
            </Button>
          )}
        </div>
      </header>

      {originalView ? (
        <>
          {!article.reading && <p className="mb-4 text-muted-foreground text-sm">This PDF has no text, only its pages.</p>}
          <object data={original!} type="application/pdf" aria-label={article.title} className="h-[80svh] w-full rounded-lg border">
            <p className="p-6">This browser cannot display PDF pages. <a className="underline" href={original!}>Open or download the original PDF</a>.</p>
          </object>
          <p className="mt-3 text-sm text-muted-foreground">Pages not showing? <a className="underline" href={`${original}?download=1`}>Download the PDF</a>.</p>
        </>
      ) : played === "video" ? (
        <video src={original!} controls preload="metadata" aria-label={article.title} className="w-full rounded-lg bg-black" />
      ) : played === "audio" ? (
        <audio src={original!} controls preload="metadata" aria-label={article.title} className="w-full" />
      ) : article.reading ? (
        <>
          <div id={ARTICLE_ID} className="article" dir="auto" dangerouslySetInnerHTML={{ __html: article.reading }} />
          <Progress id={article.id} progress={article.progress} />
          <Highlights id={article.id} title={article.title} url={article.url} highlights={article.highlights} articleNote={article.note} />
          <Notes />
          <Player id={article.id} title={article.title} site={article.site} listenedTo={article.listenedTo} />
        </>
      ) : (
        <p className="text-muted-foreground">No text was found in it: open the original.</p>
      )}
    </article>
  )
}
