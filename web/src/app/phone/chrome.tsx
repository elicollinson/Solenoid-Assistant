// What every phone screen has in common.
//
// The four screens the design draws at 390px share a frame, a header, a title
// block and a tab bar, and differ only in what sits between the title and the
// bar. Extracted here so a change to the frame is one change rather than four,
// and so the tab bar's destinations are named in exactly one place — a screen
// that disagreed with the others about what the phone can reach would be a bug
// nobody notices until they tap it.
import type { CSSProperties, ReactNode } from "react";
import { TabBar } from "../../kit";
import { useInstalled } from "../frame";

/**
 * The four destinations, in the order the bar draws them.
 *
 * The rail carries seven on the desktop. The design deletes three of them here
 * rather than shrinking them: Reminders and Recommendations have no phone
 * screen drawn, and the aside they lived beside disappears below 700px. They
 * are absent, not hidden — nothing on the phone claims they exist.
 */
export const PHONE_TABS = ["Activity", "Calendar", "Things I know", "Workflows"] as const;
export type PhoneTab = (typeof PHONE_TABS)[number];

/** What the bar calls each one. "Things I know" is the rail's name for the
 *  store and does not fit a quarter of 390px, so the bar says Memory. */
const TAB_LABEL: Record<PhoneTab, string> = {
  Activity: "Activity",
  Calendar: "Calendar",
  "Things I know": "Memory",
  Workflows: "Workflows",
};

/**
 * The design's phone frame is 390×844.
 *
 * Kept at that size where there is room — a desktop browser narrowed past the
 * breakpoint, the design's own canvas — and allowed to fill a smaller window
 * rather than overflow it, which is what an actual phone gives it.
 *
 * Installed, it stops being a frame and becomes the window. The border, the
 * rounded corners and the shadow are all drawing a device sitting on a canvas;
 * once the OS is drawing the real window around it, they read as a picture of
 * a phone inside a phone. So they go, and it fills.
 */
export const phoneFrame = (installed: boolean): CSSProperties => ({
  position: "relative",
  // The border is part of the 390, not added to it. Without this the frame is
  // 392px wide inside a 390px viewport and the whole app scrolls sideways by
  // the width of its own border — which on a phone is a page that slides under
  // your thumb while you are trying to scroll it down.
  boxSizing: "border-box",
  width: installed ? "100%" : "min(390px, 100vw)",
  // dvh rather than vh: on iOS the visible height changes as the URL bar
  // collapses, and vh is the taller of the two, which hides the tab bar.
  height: installed ? "100dvh" : "min(844px, 100dvh)",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  background: "var(--surface-app)",
  color: "var(--text-2)",
  border: installed ? "none" : "var(--border-strong)",
  borderRadius: installed ? 0 : "var(--radius-frame)",
  boxShadow: installed ? "none" : "var(--shadow-frame)",
  font: "var(--text-body)",
});

/** The frame, the header, and the tab bar. Everything a screen passes as
 *  children scrolls or sits between them. */
export function PhoneScreen({
  meta,
  tab,
  onTab,
  children,
}: {
  /** The mono line top-right: "8 workflows", "Aug 24 – 30". */
  meta?: ReactNode;
  tab: PhoneTab;
  onTab: (tab: PhoneTab) => void;
  children?: ReactNode;
}) {
  const installed = useInstalled();
  return (
    <div data-frame="phone" data-installed={installed ? "" : undefined} style={phoneFrame(installed)}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-5)",
          // The status bar and the notch sit over the header once installed, so
          // the header owns the inset. It is 0 in a browser tab.
          padding: "calc(var(--sp-8) + var(--safe-top)) var(--gutter-phone) var(--sp-6)",
          flexShrink: 0,
        }}
      >
        {/* The product name beside two geometric marks. There is no logo in
            this system and drawing one would read as foreign immediately. */}
        <span aria-hidden="true" style={{ width: 11, height: 11, borderRadius: "50%", background: "var(--signal-rust)" }} />
        <span aria-hidden="true" style={{ width: 11, height: 11, background: "var(--accent)" }} />
        <span style={{ font: "var(--text-title)", color: "var(--text-1)" }}>Solenoid</span>
        {meta ? (
          <span
            style={{
              marginLeft: "auto",
              font: "var(--text-mono-meta)",
              letterSpacing: "var(--tracking-control)",
              textTransform: "uppercase",
              color: "var(--text-3)",
            }}
          >
            {meta}
          </span>
        ) : null}
      </header>

      {children}

      <TabBar
        items={PHONE_TABS.map((label) => ({ label: TAB_LABEL[label], selected: label === tab }))}
        onSelect={(_item, index) => {
          const next = PHONE_TABS[index];
          if (next) onTab(next);
        }}
        style={{ flexShrink: 0 }}
      />
    </div>
  );
}

/** The screen's name and the agent's line under it. */
export function PhoneTitle({ title, lede }: { title: string; lede?: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-3)",
        padding: "0 var(--gutter-phone) var(--sp-7)",
        flexShrink: 0,
      }}
    >
      <h1 style={{ margin: 0, font: "var(--text-phone-display)", letterSpacing: "var(--tracking-display)", color: "var(--text-1)" }}>
        {title}
      </h1>
      {lede ? <p style={{ margin: 0, font: "var(--text-phone-lede)", color: "var(--text-3)", textWrap: "pretty" }}>{lede}</p> : null}
    </div>
  );
}

/** What I did not do, under the list. Nothing when nobody wrote one. */
export function PhoneRestraint({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <p style={{ margin: "var(--sp-8) 0 0", font: "var(--text-phone-note)", color: "var(--text-3)", textWrap: "pretty" }}>{children}</p>
  );
}

/**
 * The scrolling body between the title and the tab bar.
 *
 * The design pads its foot by `--phone-scroll-pad`, which is the ask button
 * plus clearance: the disc floats over the bottom-right of the list, and the
 * last row has to be scrollable out from under it. Nothing floats here — the
 * ask button opens Chat, and there is no chat to open — so the padding is
 * ordinary breathing room until there is. Swap it back when the disc arrives.
 */
export function PhoneBody({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflow: "auto",
        padding: "0 var(--gutter-phone) var(--sp-9)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** What a screen says while it is reading, and when it could not. Same two
 *  states the desktop draws, in the phone's own measure. */
export function PhoneNotice({ label, text }: { label: string; text: string }) {
  return (
    <PhoneBody>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-5)", paddingTop: "var(--sp-9)" }}>
        <span
          style={{
            font: "var(--text-mono-label)",
            letterSpacing: "var(--tracking-label)",
            textTransform: "uppercase",
            color: "var(--text-4)",
          }}
        >
          {label}
        </span>
        <p style={{ margin: 0, font: "var(--text-phone-lede)", color: "var(--text-2)", textWrap: "pretty" }}>{text}</p>
      </div>
    </PhoneBody>
  );
}
