// Which frame the browser is, and which theme it wants.
//
// Both are readings of the browser rather than choices the app makes, so both
// are media queries and both re-read when the query changes — a window dragged
// narrow, a phone turned sideways, the system flipping to dark at sunset.
import { useEffect, useState } from "react";
import type { Surface } from "./api";

/**
 * The breakpoint.
 *
 * "Below roughly 700px" is where the design says the system drops to its bones:
 * the rail flattens to a tab bar, the aside is deleted and the cards give way
 * to a timeline. It is written here once, as a number, because a component that
 * decided for itself would eventually disagree with the one beside it.
 *
 * A tablet is above it on purpose. The iPad is the desktop narrowed — rail at
 * 212px, cards intact — and the phone timeline on a tablet is wrong.
 */
export const PHONE_MAX = 699;

/** True while the viewport is a phone. Server-rendered as false: there is no
 *  window to measure, and the desktop is the frame the design starts from. */
export function usePhoneFrame(): boolean {
  return useMediaQuery(`(max-width: ${PHONE_MAX}px)`);
}

/**
 * Whether the system is asking for the dark theme.
 *
 * The desktop rail carries a button that flips Paper and Dusk. The phone has no
 * rail and the design draws no control in its place, so rather than invent one
 * the phone follows what the device already says it wants. That is the
 * platform's own signal, not a new affordance.
 */
export function usePrefersDusk(): boolean {
  return useMediaQuery("(prefers-color-scheme: dark)");
}

/**
 * Whether the app is running installed rather than in a browser tab.
 *
 * Two signals, because one of them is not enough. `display-mode` is the
 * standard and is what a Mac dock app and Android answer to; iOS only started
 * reporting it in 16.4, and before that a home-screen app is only identifiable
 * by `navigator.standalone`, which is Apple's own and older than the spec.
 *
 * Neither changes while the app is open — you cannot install it out from under
 * itself — so the non-standard half is read once rather than subscribed to.
 */
export function useInstalled(): boolean {
  const byDisplayMode = useMediaQuery("(display-mode: standalone), (display-mode: fullscreen)");
  return byDisplayMode || APPLE_STANDALONE;
}

const APPLE_STANDALONE =
  typeof navigator !== "undefined" && (navigator as Navigator & { standalone?: boolean }).standalone === true;

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window === "undefined" ? false : window.matchMedia(query).matches));

  useEffect(() => {
    const list = window.matchMedia(query);
    // Read once on subscribe as well: the query can have changed between the
    // first render and this effect, and the app would then draw the wrong frame
    // until something else happened to resize the window.
    setMatches(list.matches);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/** What to ask the API for, given the frame. The two names are deliberately
 *  the same word: the query parameter is this reading, sent. */
export function surfaceOf(phone: boolean): Surface {
  return phone ? "phone" : "desktop";
}
