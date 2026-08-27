// Activity at 390px — the design's phone option 3b.
//
// The desktop draws this as cards in a three-column frame. Neither survives the
// width: the borders and surface tints that read as structure on a 1240px
// canvas read as noise here, and the aside has nowhere to go. So the cards give
// way to one hairline down the page with the status marks sitting on it, and
// the aside is deleted rather than folded — everything it held was already the
// top of this feed.
//
// At most two entries are prominent. The server decides which, because "the two
// things waiting on you" is a fact about the feed and not about the frame it is
// drawn in; `prominence` is a column.
import { Button, Meter, SectionRule, TimelineFeed, TimelineItem } from "../../kit";
import type { HomeAction, HomeFeedItem, HomePayload } from "../api";
import { PhoneBody, PhoneTitle } from "./chrome";

const STANCE_TO_VARIANT: Record<HomeAction["stance"], "affirm" | "quiet" | "bare" | "danger"> = {
  affirm: "affirm",
  neutral: "quiet",
  quiet: "quiet",
  bare: "bare",
  danger: "danger",
};

/**
 * The lede, split where the count begins.
 *
 * The server writes it as one string in two halves — what I did, then what is
 * still stopped on you. The design sets the second half in amber, which needs
 * them apart. Splitting on the first full stop is the same seam `recount` uses
 * to rewrite that half when you settle something in the browser.
 */
function halves(lede: string): [string, string] {
  const stop = lede.indexOf(".");
  if (stop === -1) return [lede, ""];
  return [lede.slice(0, stop + 1), lede.slice(stop + 1).trim()];
}

export function ActivityPhone({
  home,
  resolved,
  onInvoke,
}: {
  home: HomePayload;
  resolved: ReadonlySet<string>;
  onInvoke: (action: HomeAction) => void;
}) {
  const [did, waiting] = halves(home.header.lede);

  return (
    <>
      <PhoneTitle title={home.header.greeting} />
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)", padding: "0 var(--gutter-phone) var(--sp-8)", flexShrink: 0 }}>
        <p style={{ margin: 0, font: "var(--text-phone-lede)", color: "var(--text-2)", textWrap: "pretty" }}>
          {did}
          {waiting ? (
            <>
              <br />
              <span style={{ color: "var(--signal-amber-text)", fontWeight: 500 }}>{waiting}</span>
            </>
          ) : null}
        </p>
      </div>

      <PhoneBody>
        {home.sections.map((section) => (
          <div key={section.label} style={{ display: "flex", flexDirection: "column" }}>
            <SectionRule label={section.label} style={{ padding: "var(--sp-6) 0 var(--sp-8)" }} />
            <TimelineFeed>
              {section.items.map((item) => (
                <Entry key={item.id} item={item} settled={item.decisionId != null && resolved.has(item.decisionId)} onInvoke={onInvoke} />
              ))}
            </TimelineFeed>
          </div>
        ))}
      </PhoneBody>
    </>
  );
}

/**
 * One line of the feed.
 *
 * Settling a gate here has to turn the entry done and take its buttons away, or
 * the phone goes on offering an answer to something already answered — the same
 * bargain the desktop feed strikes, and for the same reason: nothing writes to
 * the database yet, so the click is the whole of what changes.
 */
function Entry({
  item,
  settled,
  onInvoke,
}: {
  item: HomeFeedItem;
  settled: boolean;
  onInvoke: (action: HomeAction) => void;
}) {
  const state = settled ? "done" : item.state;
  const prominent = item.prominent && !settled;

  return (
    <TimelineItem
      state={state}
      prominent={prominent}
      title={item.title}
      time={item.time}
      // `actions` is the kit's slot for "a wrapping row under the body", which
      // is where the design puts both the buttons and a running item's meter.
      // The meter goes here rather than in `children` because children is a
      // <p>: a div inside it is invalid markup, and a running entry never
      // carries buttons for it to collide with.
      actions={
        prominent && item.actions.length ? (
          item.actions.map((a) => (
            <Button key={a.id} variant={STANCE_TO_VARIANT[a.stance]} size="touch" onClick={() => onInvoke(a)}>
              {a.label}
            </Button>
          ))
        ) : item.progress ? (
          <Meter value={item.progress.value} total={item.progress.total} style={{ maxWidth: 180 }} />
        ) : null
      }
    >
      {item.account}
    </TimelineItem>
  );
}
