import { drawIcon } from "@/components/sphere/icon"

export async function GET(_: Request, { params }: { params: Promise<{ size: string }> }) {
  return drawIcon(Math.min(1024, Math.max(32, Number((await params).size) || 512)))
}
