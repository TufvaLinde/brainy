"use client";

import { useCallback, useSyncExternalStore } from "react";

/** The theme's own breakpoints, in px. A name here is a name `globals.css`
 *  already has: two ladders of numbers is how a pane and the query that hides
 *  it come to disagree by a pixel. */
const BREAKPOINTS = {
  sm: 640,
  md: 800,
  lg: 1024,
  xl: 1280,
  "2xl": 1536,
  "3xl": 1600,
  "4xl": 2000,
} as const;

type Breakpoint = keyof typeof BREAKPOINTS;

/** `"md"` is md and wider, `"max-md"` is narrower than md — the two senses
 *  Tailwind spells the same way. Anything opening with `(` is a raw media query
 *  and passes through untouched. */
type BreakpointQuery = Breakpoint | `max-${Breakpoint}` | (string & {});

function queryOf(q: BreakpointQuery): string {
  if (q.startsWith("(")) return q;
  const below = q.startsWith("max-");
  const px = BREAKPOINTS[(below ? q.slice(4) : q) as Breakpoint];
  if (px == null) return q;
  return below ? `(max-width: ${px - 1}px)` : `(min-width: ${px}px)`;
}

/** Does the viewport match? FALSE on the server and in the first client render,
 *  so the two agree — a hook that guessed would hydrate one layout into markup
 *  drawn for the other. */
export function useMediaQuery(query: BreakpointQuery): boolean {
  const mq = queryOf(query);

  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(mq);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [mq],
  );

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(mq).matches,
    () => false,
  );
}
