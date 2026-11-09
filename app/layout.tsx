import type { Metadata, Viewport } from "next"
import Link from "next/link"
import Script from "next/script"
import { AppearanceMenu } from "@/components/appearance"
import { ToastProvider } from "@/components/ui/toast"
import { applyAppearance, KEY } from "@/lib/appearance"
import "./globals.css"

export const metadata: Metadata = {
  title: "Brainy",
  description: "Say how you feel and how long you have; Brainy finds what to read.",
  // An article's links don't tell their sites what else is saved here.
  referrer: "no-referrer",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Brainy", statusBarStyle: "default" },
}

export const viewport: Viewport = { themeColor: "#f4f2ed", viewportFit: "cover" }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The appearance script sets the html's class and style before React
    // hydrates, so they are the browser's, not React's.
    <html lang="en" suppressHydrationWarning>
      {/* Base UI's documented setup: the isolated wrapper keeps portaled popups
          above the page; the relative body keeps backdrops covering iOS's
          visual viewport. */}
      <body className="relative">
        <Script id="appearance" strategy="beforeInteractive">
          {`try{(${applyAppearance})(JSON.parse(localStorage.getItem("${KEY}")??"{}"))}catch{}`}
        </Script>
        <ToastProvider position="bottom-center">
          <div className="relative isolate mx-auto min-h-svh max-w-(--column) px-6 pb-32">
            <header className="flex items-center justify-between pt-[max(0.75rem,env(safe-area-inset-top))] pb-1">
              <Link className="flex items-center gap-1.5 font-bold text-[15px] tracking-[-0.02em]" href="/">
                {/* A small black work on the wall. */}
                <span aria-hidden className="size-3.5 bg-foreground" />
                Brainy
              </Link>
              <AppearanceMenu />
            </header>
            <main>{children}</main>
          </div>
        </ToastProvider>
      </body>
    </html>
  )
}
