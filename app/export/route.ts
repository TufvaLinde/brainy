import { libraryArchive } from "@/lib/archive"

/** The whole library as a zip, to keep, to read without this app, or to
 *  restore from by uploading it (see lib/archive). */
export async function GET() {
  const day = new Date().toISOString().slice(0, 10)
  return new Response(libraryArchive(), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="Brainy library ${day}.zip"`,
      "cache-control": "no-store",
    },
  })
}
