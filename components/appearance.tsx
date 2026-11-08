"use client"

import { ALargeSmall } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { type Appearance, applyAppearance, KEY, LINE_HEIGHTS, SIZES, WIDTHS } from "@/lib/appearance"

const THEMES = { Auto: "auto", Light: "light", Dark: "dark" } as const
const FONTS = { Sans: "sans", Serif: "serif" } as const

/** What this browser kept, or nothing, for the defaults to fill. */
function stored(): Partial<Appearance> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}")
  } catch {
    return {}
  }
}

/** Theme, typeface, text size, line spacing and column width, each applied
 *  the moment it is picked and kept in this browser. Read as the menu opens:
 *  before that, only the browser knows them. */
export function AppearanceMenu() {
  const [appearance, setAppearance] = useState<Appearance | null>(null)
  useEffect(() => {
    const system = matchMedia("(prefers-color-scheme: dark)")
    const changed = () => { if ((stored().theme ?? "auto") === "auto") applyAppearance(stored()) }
    system.addEventListener("change", changed)
    return () => system.removeEventListener("change", changed)
  }, [])

  const change = (patch: Partial<Appearance>) => {
    const next = applyAppearance({ ...appearance, ...patch })
    localStorage.setItem(KEY, JSON.stringify(next))
    setAppearance(next)
  }

  return (
    <Popover onOpenChange={(open) => open && setAppearance(applyAppearance(stored()))}>
      <PopoverTrigger render={<Button variant="ghost" size="icon" aria-label="Appearance" />}>
        <ALargeSmall />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        {appearance && (
          <div className="grid gap-4">
            <Choice label="Theme" options={THEMES} value={appearance.theme} onPick={(theme) => change({ theme })} />
            <Choice label="Typeface" options={FONTS} value={appearance.font} onPick={(font) => change({ font })} />
            <Choice
              label="Size"
              options={Object.fromEntries(SIZES.map((size) => [size, String(size)]))}
              value={String(appearance.size)}
              onPick={(size) => change({ size: Number(size) })}
            />
            <Choice
              label="Line spacing"
              options={Object.fromEntries(Object.entries(LINE_HEIGHTS).map(([name, height]) => [name, String(height)]))}
              value={String(appearance.lineHeight)}
              onPick={(lineHeight) => change({ lineHeight: Number(lineHeight) })}
            />
            <Choice
              label="Width"
              options={Object.fromEntries(Object.entries(WIDTHS).map(([name, width]) => [name, String(width)]))}
              value={String(appearance.width)}
              onPick={(width) => change({ width: Number(width) })}
            />
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** A row of options by name, one of them picked. */
function Choice<T extends string>({
  label,
  options,
  value,
  onPick,
}: {
  label: string
  options: Record<string, T>
  value: T
  onPick: (value: T) => void
}) {
  return (
    <div className="grid gap-1.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      <ToggleGroup
        value={[value]}
        onValueChange={([picked]) => picked && onPick(picked as T)}
        variant="outline"
        size="sm"
        className="w-full"
        aria-label={label}
      >
        {Object.entries(options).map(([name, option]) => (
          <ToggleGroupItem key={name} value={option} className="flex-1">
            {name}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}
