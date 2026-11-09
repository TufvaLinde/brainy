import { NextResponse, type NextRequest } from "next/server"

/** With BRAINY_PASSCODE set, nothing but the way in is served until the
 *  passcode is given, once per browser; a Shortcuts automation, which has no
 *  cookies, gives it as ?key=. Unset, as on a laptop at home, all is open. */
export function proxy(request: NextRequest) {
  const passcode = process.env.BRAINY_PASSCODE
  if (!passcode) return NextResponse.next()
  const { pathname, searchParams } = request.nextUrl
  if (request.cookies.get("brainy_pass")?.value === passcode) return NextResponse.next()
  if (pathname.startsWith("/api/hybrid/signal") && searchParams.get("key") === passcode) return NextResponse.next()
  if (pathname.startsWith("/api/") || request.method !== "GET") return NextResponse.json({ error: "Locked" }, { status: 401 })
  const unlock = new URL("/unlock", request.url)
  unlock.searchParams.set("next", pathname + request.nextUrl.search)
  return NextResponse.redirect(unlock)
}

export const config = {
  // The way in, and what installing the app needs, stay open.
  matcher: ["/((?!unlock|_next/static|_next/image|icons|apple-icon|manifest.webmanifest|sw.js|favicon.ico).*)"],
}
