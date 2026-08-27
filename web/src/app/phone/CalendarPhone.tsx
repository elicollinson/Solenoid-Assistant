// The calendar at 390px — day strip, agenda, detail sheet.
//
// The desktop plots the week on a canvas. Plotting needs width the phone does
// not have, so the week becomes seven cells across the top and the day becomes
// the page: a list on hairline rules with a mono time gutter, the status mark,
// and the thing itself. Kind is carried by typeface and by the left rule rather
// than by position, because there is no position left to carry it.
//
// One line per day rather than one about the week, for the same reason — you
// can only see one day at a time, so the agent says something about the day you
// are looking at. The server writes those; `CalendarDay.lede` is where they
// arrive, and it is null on the desktop, which draws the week's line instead.
import { useState } from "react";
import { Agenda, AgendaNow, AgendaRow, Badge, Button, DayStrip, MonoLabel, Sheet } from "../../kit";
import type { CalendarDetailPayload, CalendarItem, CalendarPayload, HomeAction, Load } from "../api";
import { PhoneBody, PhoneRestraint, PhoneTitle } from "./chrome";

const KIND_LABEL: Record<CalendarItem["kind"], string> = {
  event: "yours",
  run: "my run",
  reminder: "reminder",
  hold: "held slot",
};

const STATE_LABEL: Record<string, string> = {
  attention: "needs you",
  running: "running",
  done: "done",
  failed: "failed",
};

/** "11:23" from minutes past midnight, which is what the payload carries so
 *  the desktop can position the now-line on a pixel grid. */
function clock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Minutes past midnight for an agenda row's "HH:MM", so the now-line can be
 *  dropped in at the right point in the list. */
const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export function CalendarPhone({
  calendar,
  detail,
  openId,
  onOpen,
  onInvoke,
}: {
  calendar: CalendarPayload;
  detail: Load<CalendarDetailPayload>;
  openId: string | null;
  onOpen: (id: string | null) => void;
  onInvoke: (action: HomeAction) => void;
}) {
  const [day, setDay] = useState(calendar.days[0]?.key ?? "d0");
  const shown = calendar.days.find((d) => d.key === day) ?? calendar.days[0];
  const items = calendar.items.filter((i) => i.day === day);
  const open = openId ? calendar.items.find((i) => i.id === openId) : undefined;

  // The now-line is drawn where today has got to, and only on today: a line
  // across Thursday saying it is twenty past eleven would be a clock, not a
  // reading of the day.
  const rows: React.ReactNode[] = [];
  let drawnNow = !shown?.today;
  for (const item of items) {
    if (!drawnNow && minutesOf(item.start) > calendar.now) {
      rows.push(<AgendaNow key="now" time={clock(calendar.now)} />);
      drawnNow = true;
    }
    rows.push(
      <AgendaRow
        key={item.id}
        kind={item.kind}
        state={item.state ?? undefined}
        start={item.start}
        end={item.end}
        title={item.title}
        meta={item.meta ?? undefined}
        selected={openId === item.id}
        onClick={() => onOpen(item.id)}
      />,
    );
  }
  if (!drawnNow) rows.push(<AgendaNow key="now" time={clock(calendar.now)} />);

  return (
    <>
      <PhoneTitle title="Calendar" lede={shown?.lede ?? calendar.lede} />

      <DayStrip
        days={calendar.days.map((d) => ({
          key: d.key,
          label: d.label,
          date: d.date,
          today: d.today,
          count: calendar.items.filter((i) => i.day === d.key).length,
        }))}
        selected={day}
        onSelect={(key) => {
          setDay(key);
          onOpen(null);
        }}
        style={{ flexShrink: 0 }}
      />

      <PhoneBody style={{ background: shown?.today ? "var(--surface-panel)" : "transparent" }}>
        <Agenda>{rows}</Agenda>
        {/* Two different things, and both belong here. The first is what I held
            back from on this day; the second is what I am holding back from all
            week, which is the boiler slot still waiting on you — hiding it on
            the day the app opens on would hide the one that matters most. */}
        <PhoneRestraint>{shown?.restraint}</PhoneRestraint>
        <PhoneRestraint>{calendar.restraint}</PhoneRestraint>
      </PhoneBody>

      {open ? <Detail item={open} detail={detail} onClose={() => onOpen(null)} onInvoke={onInvoke} /> : null}
    </>
  );
}

/**
 * One thing on the day.
 *
 * The row that was tapped is handed straight in, so the title, the time and the
 * mark are drawn before the read comes back — only the account and the pairs
 * wait on it. The desktop aside strikes the same bargain for the same reason:
 * opening something you can already see should not blank it first.
 */
function Detail({
  item,
  detail,
  onClose,
  onInvoke,
}: {
  item: CalendarItem;
  detail: Load<CalendarDetailPayload>;
  onClose: () => void;
  onInvoke: (action: HomeAction) => void;
}) {
  const loaded = detail.status === "ready" && detail.data.id === item.id ? detail.data : null;

  return (
    <Sheet label={KIND_LABEL[item.kind]} onClose={onClose} height="var(--sheet-h-short)" style={{ bottom: "var(--tabbar-total)" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
        <h2
          style={{
            margin: 0,
            font: "var(--text-phone-title)",
            letterSpacing: "var(--tracking-title)",
            color: "var(--text-1)",
            textWrap: "pretty",
          }}
        >
          {item.title}
        </h2>
        <span style={{ font: "var(--text-mono)", color: "var(--text-3)" }}>{loaded?.when ?? item.meta ?? item.start}</span>
        {item.state ? (
          <Badge
            tone={item.state === "attention" ? "attention" : item.state === "running" ? "running" : "neutral"}
            style={{ alignSelf: "flex-start" }}
          >
            {STATE_LABEL[item.state] ?? item.state}
          </Badge>
        ) : null}
      </div>

      {detail.status === "error" ? (
        <p style={{ margin: 0, font: "var(--text-phone-body)", color: "var(--text-3)", textWrap: "pretty" }}>
          I couldn&rsquo;t open that one — {detail.message}.
        </p>
      ) : null}

      {loaded && loaded.account.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
          <MonoLabel>Why it is here</MonoLabel>
          {loaded.account.map((p) => (
            <p key={p} style={{ margin: 0, font: "var(--text-phone-lede)", color: "var(--text-2)", textWrap: "pretty" }}>
              {p}
            </p>
          ))}
        </div>
      ) : null}

      {loaded && loaded.pairs.length ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--sp-5)" }}>
          {loaded.pairs.map((pair) => (
            <div key={pair.label} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span
                style={{
                  font: "var(--text-mono-label)",
                  letterSpacing: "var(--tracking-label)",
                  textTransform: "uppercase",
                  color: "var(--text-4)",
                }}
              >
                {pair.label}
              </span>
              <span style={{ font: "var(--text-body-sm)", color: "var(--text-1)" }}>{pair.value}</span>
            </div>
          ))}
        </div>
      ) : null}

      {loaded && loaded.actions.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
          {loaded.actions.map((a) => (
            <Button key={a.id} variant={a.stance === "affirm" ? "affirm" : "quiet"} size="touch" onClick={() => onInvoke(a)}>
              {a.label}
            </Button>
          ))}
        </div>
      ) : null}
    </Sheet>
  );
}
