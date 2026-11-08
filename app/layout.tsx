import { BookOpen } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import Script from "next/script"
import { AppearanceMenu } from "@/components/appearance"
import { ToastProvider } from "@/components/ui/toast"
import { applyAppearance, KEY } from "@/lib/appearance"
import "./globals.css"

export const metadata: Metadata = {
  title: "Reader",
  description: "Save a link, read it clean, listen to it.",
  // An article's links don't tell their sites what else is saved here.
  referrer: "no-referrer",
}

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
            <header className="flex items-center justify-between py-6">
              <Link className="flex items-center gap-2 font-medium text-lg" href="/">
                <BookOpen className="size-5" />
                Reader
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
