# The Solenoid kit

Everything a surface in this app is allowed to draw with. Ported from the
Claude Design project (`Personal Agent UI Design`), which stays the source of
truth for how any of it looks — change the design first, then bring the change
across.

```
tokens/       colours, type, spacing, surfaces, base — Paper and Dusk
core/         Button Chip Badge StatusMark Panel Meter SectionRule MonoLabel Tabs
agent/        ActivityItem ToolCalls RailItem RailGroup TimeGrid CalendarEvent
              TraceTree LogStream Evidence
mobile/       TimelineFeed DayStrip Agenda Sheet TabBar AskButton
```

The tiers are a real boundary: `core` knows nothing about the agent, `agent`
knows about runs and evidence but not about page layout, and `mobile` is the
phone's own vocabulary rather than the desktop's at a smaller width.

`mobile/` is drawn by `web/src/app/phone/`, which the app switches to below
700px — see `web/src/app/frame.ts`. `AskButton` is the one piece with nowhere to
be used yet: it opens a Chat screen the design has and this app does not.

## Four rules that are easy to break

**Status is a geometric mark, never a pictorial icon.** Amber triangle needs
you, green ring is running, blue square is done, rust diamond failed. There is
no icon font here and adding one would read as foreign immediately — everything
else that would be an icon is a single mono character (`▸ ▾ › · ▌ →`).

**Two families, strictly divided.** Space Grotesk for anything a person wrote
or reads as prose; IBM Plex Mono for anything a machine produced — timestamps,
durations, tool calls, ids, counts, section labels, and every all-caps control.
UPPERCASE appears only in mono.

**Flat planes, 1px rules, no shadows inside the frame.** Depth is four steps of
surface tint plus hairlines. No gradients, no blur, no transparency. Only the
app frame and the phone's ask button cast a shadow. Transitions are 90–140ms
and apply to colour only; the running ring is the one thing allowed to move.

**Style through the tokens, never with a literal colour.** `web/src/main.tsx`
imports `tokens.css` once. Every component reads `var(--…)`, which is what makes
`data-theme="dusk"` flip the whole frame — a hardcoded hex survives the switch
and breaks the theme.

## Themes

Paper is the default; `data-theme="dusk"` on any container switches that
subtree. Both are defined in `tokens/colors.css` as semantic aliases over two
literal ramps, so a component never names a ramp directly.

## Adding a component

Port it from the design project rather than inventing it, keep the props the
design's `.d.ts` declares, and write it plainly — React Compiler is on, so
`useMemo`, `useCallback` and `React.memo` are not needed and should not appear.
Export it from `index.ts` alongside its types.
