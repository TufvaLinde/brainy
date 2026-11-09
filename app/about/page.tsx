import type { Metadata } from "next"
import { About } from "@/components/sphere/about"

export const metadata: Metadata = { title: "How Brainy works" }

export default function AboutPage() {
  return <About />
}
