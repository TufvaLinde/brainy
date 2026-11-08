import { Skeleton } from "@/components/ui/skeleton"

/** The reading view's outline, shown the moment a card is opened, while the
 *  article comes from the database far away. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Opening" className="mt-6">
      <Skeleton className="h-8 w-3/4" />
      <Skeleton className="mt-3 h-4 w-1/3" />
      <div className="mt-10 grid gap-3">
        {["w-full", "w-full", "w-11/12", "w-full", "w-2/3"].map((width, i) => (
          <Skeleton key={i} className={`h-4 ${width}`} />
        ))}
      </div>
    </div>
  )
}
