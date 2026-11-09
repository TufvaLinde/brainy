import { cookies } from "next/headers"
import { redirect } from "next/navigation"

async function unlock(form: FormData) {
  "use server"
  const next = String(form.get("next") || "/sphere")
  if (String(form.get("passcode")) !== process.env.BRAINY_PASSCODE) redirect(`/unlock?wrong=1&next=${encodeURIComponent(next)}`)
  ;(await cookies()).set("brainy_pass", process.env.BRAINY_PASSCODE!, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 365 * 24 * 3600, path: "/" })
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/sphere")
}

export default async function Unlock({ searchParams }: { searchParams: Promise<{ next?: string; wrong?: string }> }) {
  const { next = "/sphere", wrong } = await searchParams
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#07060d] px-6 text-white">
      <form action={unlock} className="w-full max-w-xs space-y-3">
        <h1 className="text-xl font-semibold">Brainy</h1>
        <input type="hidden" name="next" value={next} />
        <input name="passcode" type="password" autoFocus placeholder="Passcode" className="w-full rounded-full bg-white/10 px-4 py-3 outline-none ring-1 ring-white/15 focus:ring-violet-400" />
        {wrong && <p className="text-sm text-rose-300">That isn&apos;t it.</p>}
        <button className="w-full rounded-full bg-violet-500 py-3 font-medium">Unlock</button>
      </form>
    </div>
  )
}
