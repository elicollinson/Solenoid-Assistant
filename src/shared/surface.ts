// Which shape of screen is asking.
//
// The design keeps separate copy for the phone rather than reflowing the
// desktop's — "the phone is not the desktop feed at a smaller width" — so the
// request has to say which it is before a loader can pick the right sentence.
// `narratives.surface` and `surface_notes.surface` were built for this; this is
// the name the wire uses for it.
//
// Pure types and nothing else, for the same reason src/shared/home.ts is: the
// browser half compiles against this file and has no Bun types.

/** The two frames the app draws. Below roughly 700px it is the phone. */
export type Surface = "desktop" | "phone";

/** The default, and the fallback when a surface has no copy of its own. */
export const DESKTOP: Surface = "desktop";

/** Whether an arbitrary string names a surface. Guards the query parameter. */
export function isSurface(value: unknown): value is Surface {
  return value === "desktop" || value === "phone";
}
