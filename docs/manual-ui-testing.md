# Manual UI functionality-testing runbook

This runbook is the reusable manual check for the browser UI in `web/`. It is
based on the implemented React surfaces, their API clients, the Elysia routes,
and the seeded data on `main`. It deliberately does not describe controls or
phone screens that the repository does not implement.

Use it for exploratory UI checks, release qualification, and evidence-backed
bug reports. Do not treat it as permission to run workflows against personal
messages, Photos, or production collections.

## Current product boundary

The same origin presents two different shells at the `699px` breakpoint.

| Area | Desktop, 700px and wider | Phone, 699px and narrower | Persistence |
| --- | --- | --- | --- |
| Chat | Transcript, conversation rail, composer, streamed tool activity, write approvals | Conversation list, thread, one-line composer | Conversations, completed turns, and approval outcomes are stored |
| Activity | Filtered feed plus the Waiting on you / Next up / Worth a look aside | Timeline feed; no filters or aside | Most decision actions settle only in the current browser session |
| Workflows | List, filters, detail, run form, pause/resume, kill, instructions, permissions, executions, trace, logs | Filtered/grouped list and a sheet carrying the same: Summary, Runs, Trace, Logs, run form, kill, instructions, permissions | Pause/resume, Run, Kill, instructions and permissions persist on both shells |
| Reminders | List, filters, detail, evidence | Same list, filters, sheet and evidence viewer, reached from the Calendar tab's segment row | Done and Later are session-local; destructive/edit controls are disabled |
| Calendar | Week/day time grid and detail aside | Seven-day strip, agenda, and detail sheet | Read-only apart from navigation or session-local decision effects |
| Things I know | Group filters, client-side search, memory detail | Group filters and memory detail sheet | Read-only; all memory write/conflict controls are disabled |
| Recommendations | List, filters, detail, evidence, adopt/decline | Same list, filters, sheet and evidence, reached from the Memory tab's segment row | Adopt/decline is written to the API, with optimistic UI rollback on refusal |
| Theme | Paper/Dusk button | Follows the device color-scheme preference | Session-local |
| PWA | Installable production build | Installable portrait home-screen app with safe-area layout | Only the app shell is cached; `/api` is always live-network-only |

There is no login screen, cookie/session check, or API authorization in this
repository. The server binds to `127.0.0.1` by default. Remote access is meant
to use Tailscale Serve, where tailnet membership is the access boundary. Never
set `HOST=0.0.0.0` for this test on an untrusted network.

## Source-confirmed limitations to preserve in test reports

These are current implementation facts, not test setup failures:

- Desktop **Stop everything** looks enabled but has no click handler.
- Desktop Activity decision actions and reminder Done/Later changes do not
  write to SQLite. They revert on reload. Calendar actions can navigate, but
  do not themselves perform an external operation.
- Phone workflow Pause/Resume, Run, Kill run, standing instructions and tool
  permissions write to the server and re-read, as on the desktop. The sheet's
  Runs, Trace and Logs tabs draw the same run record and log store answers.
- Reminders and Recommendations have no bar entry of their own on the phone:
  seven labels do not fit a 390px bar. They sit behind Calendar and Memory
  respectively, one segment row down, and every navigation effect aimed at
  either reaches it.
- Memory edits, conflict resolution, and deletion are disabled on both shells.
- The service worker caches the document and fetched static assets, never API
  responses. An offline launch should draw the shell and an API error, not old
  assistant data.
- Several custom controls intentionally remove browser-native styling but do
  not add a focus-visible treatment. Desktop calendar blocks and knowledge rows
  are clickable `div` elements without keyboard semantics; phone agenda rows
  have the same limitation. Phone sheets are not modal dialogs and do not trap
  focus or close on Escape. Record these as accessibility defects if observed;
  do not mark keyboard coverage as passing by skipping them.

## Prerequisites and safe setup

Required for the fixture-backed checks:

- Bun 1.3 or newer and dependencies installed with `bun install`.
- A Chromium- or WebKit-based desktop browser with DevTools.
- A viewport emulator or a physical phone for the 390px checks.
- Two terminals in the repository root.

Use a disposable database. `db:seed` clears the non-OKF data it owns in its
target, so never point the commands below at a database that matters.

In terminal A:

```bash
export SOLENOID_UI_TEST_DIR="$(mktemp -d)"
export DATABASE_URL="$SOLENOID_UI_TEST_DIR/solenoid.db"
bun run db:seed "$DATABASE_URL"
bun run db:sync-workflows "$DATABASE_URL"
bun run db:index-okf okf "$DATABASE_URL"
bun run start:server
```

In terminal B:

```bash
bun run dev:web
```

Open `http://localhost:5173`. Confirm terminal A reports the API on `:3000`
and that `curl http://localhost:3000/health` returns `{"status":"ok"}`.

The seed is anchored to the day it runs. Useful stable records include:

- Activity/workflows: **Q3 vendor reconciliation**, **Weekly digest**, and
  **Ferris contract review** cover running, failed, and needs-you states.
- Reminders: **Tell Ferris whether the credit note stands**, **Pick a slot for
  the boiler service**, and **Revised figures — sent** cover gated, open, and
  closed details with evidence/history.
- Calendar: **Latham quarter review**, **Boiler service — first slot**, and a
  projected workflow run exercise different item kinds.
- Things I know comes from the checked-in `okf/` bundle after `db:index-okf`.
- Recommendations is intentionally empty after `db:seed`. A populated test
  requires a disposable database containing a recommendation proposed through
  the real mutation/tool path; do not fabricate one with display-only JSON.
- The five catalogued workflows are the only runnable rows. The seeded design
  workflows are demonstrations and correctly have Run disabled on both shells.

For Chat or a real workflow run, also configure the model route in `.env` and
verify Model Armor with `bun run verify:model-armor`. Use read-only prompts and the disposable database unless
the individual case explicitly requires a write.

Optional native/integration cases have additional prerequisites in
[Integration and failure checks](#integration-and-failure-checks). They are not
part of routine release smoke.

## Recording a run

Start an evidence note before testing:

```text
Build/commit:
Date and operator:
Browser/OS:
Viewport or device:
Database path and seed command:
Model route (if used):
Native/external services enabled:
Result totals: PASS / FAIL / BLOCKED / NOT RUN
```

For every failed or blocked case capture:

1. The case ID and exact step that failed.
2. Expected versus observed behavior.
3. A screenshot or short recording, including the whole relevant pane.
4. DevTools Console and the failing Network request/status/body.
5. The matching server log time and request/run ID where available.

Do not attach unredacted message bodies, screenshots, contact data, memory
files, provider tokens, or private collection content to a shared issue.

## Desktop cases

Run these at 1240×840 first, then repeat layout checks at the narrowest desktop
width, 700px.

### D-NAV — shell and navigation

- [ ] **D-NAV-01 Initial load.** Open the app with the seeded API running.
  Expect the Solenoid rail, Activity selected, populated feed, agent-state
  card, and Activity aside. There should be no login prompt and no horizontal
  page scrollbar.
- [ ] **D-NAV-02 Destinations.** Open Chat, Activity, Workflows, Reminders,
  Calendar, Things I know, and Recommendations from the rail. Expect exactly
  one selected destination and the corresponding heading or empty state.
- [ ] **D-NAV-03 Route reset.** Open a detail item, then select another rail
  destination and return. Expect the destination's list/default state rather
  than a stale detail from the previous destination.
- [ ] **D-NAV-04 Theme.** Press Dusk, then Paper. Expect the full shell and all
  open content to change theme without losing the selected route. Reload and
  expect Paper again; the choice is not persisted.
- [ ] **D-NAV-05 Inert global stop.** Observe **Stop everything**. It currently
  has no handler: clicking it must not be reported as stopping any run. Record
  an issue if this active-looking inert control is still release-relevant.

### D-ACT — Activity

- [ ] **D-ACT-01 Filters.** Switch among All, Needs you, and Running. Expect
  only matching entries, selected-chip styling, and “Nothing here under that
  filter” when a populated feed has no match.
- [ ] **D-ACT-02 Feed rendering.** Confirm a running entry shows progress and
  its tool summary, a needs-you entry shows action buttons, and ordinary
  affordances render as links rather than commit buttons.
- [ ] **D-ACT-03 Local settlement.** Answer one seeded decision. Expect the
  entry to become done, show `resolved locally · no write path yet`, disappear
  from Needs you/Waiting on you, and decrement related header/rail counts.
  Reload and expect the original seeded decision to return.
- [ ] **D-ACT-04 Aside.** Confirm Waiting on you, Next up, and Worth a look
  render only when data exists and use their explicit empty copy when empty.
  A navigation action should open the named supported destination/detail.

### D-CHAT — Chat

- [ ] **D-CHAT-01 List and new conversation.** Open Chat. Expect the newest
  stored conversation to open automatically when one exists. Press New; expect
  an empty “New conversation” with a usable composer and a new row after the
  server responds.
- [ ] **D-CHAT-02 Composer rules.** Verify blank/whitespace text cannot send;
  Enter sends; Shift+Enter adds a line; the textarea grows up to its cap; and
  the Send button is disabled during a live turn.
- [ ] **D-CHAT-03 Read-only turn.** With a model configured, ask a harmless
  read-only question such as “What time is it?” Expect the user turn to appear
  immediately, live agent/tool activity to stream, the transcript to follow
  the bottom until manually scrolled up, and the completed response to survive
  reload without duplicate live/stored turns.
- [ ] **D-CHAT-04 Write approval.** In the disposable database, ask to create a
  reminder titled `UI QA delete me`. Expect the write to stop on an approval
  bubble with a reference, reason/hold text, call facts, and explicit choices.
  While waiting, expect the composer to say `Answer above first` and reject
  input. Decline once and verify the transcript says nothing was written.
  Repeat and approve only if cleanup is understood; expect the tool result and
  settled choice to survive reload.
- [ ] **D-CHAT-05 Conversation navigation.** Open another conversation from
  the right rail and return. Expect title, stored turns, status, and timestamps
  to change together, with no live turn continuing behind the newly open one.

### D-WF — Workflows

- [ ] **D-WF-01 List and filters.** Verify All, Needs you, Running, Scheduled,
  and Paused filters. Hover a row: Pause/Resume and Open should appear; Run
  should appear only for runnable, unpaused, non-running catalogued workflows.
  Pressing Enter or Space on a focused row should open it.
- [ ] **D-WF-02 Detail and tabs.** Open Q3 vendor reconciliation. Verify the
  status/cadence/last-run header, Summary, Executions, Trace, and Logs. Selecting
  an older execution must carry that same run into Trace and Logs. Expanded /
  Collapsed should reset the whole trace. Log filters must show All, Warnings,
  or Errors and report the visible/total count and source.
- [ ] **D-WF-03 No-run empty state.** Open a catalogued workflow with no runs.
  Summary should explain its purpose; Executions/Trace/Logs should say that no
  run has been recorded rather than rendering blank.
- [ ] **D-WF-04 Run form.** Open Prompt-injection screen and press Run. Expect
  one control per catalog field, required marking, defaults/help, and Run it
  disabled while required text is blank or whitespace. Set Text to screen to
  harmless text and Words per chunk to `0`; submit and expect the server's
  validation refusal inline without opening a run.
- [ ] **D-WF-05 Safe run and polling.** If Prompt Guard is installed, restore
  Words per chunk to `40` and run the harmless sample. Expect a 202-backed run,
  Starting/Running state, two-second detail refresh without Reading flashes,
  then a terminal result with write-up, effects, trace, raw result, and logs.
- [ ] **D-WF-06 Pause persistence.** Pause a catalogued workflow. Expect all
  workflow mutation controls to disable during the request, a re-read to show
  Paused, and Run to disable. Reload and expect it still paused. Resume it and
  verify the restored state. Capture and restore its original state.
- [ ] **D-WF-07 Standing instructions.** Edit a workflow's instruction. Expect
  no-op text to keep Save disabled, Cancel to discard, Save to persist after a
  re-read/reload, and clearing the text to retire the rule. Restore the original
  instruction before leaving the case.
- [ ] **D-WF-08 Stop.** Only in the disposable database, start a workflow that
  remains running long enough to observe and press Kill run. Expect the row to
  become stopped/cancelled and late output not to reopen it. Note that an
  already-issued provider request may finish in the background.

### D-REM — Reminders

- [ ] **D-REM-01 List.** Verify All, Needs you, and Done filters; due buckets;
  row title/note/source/time; attention badge; and filter empty copy. Enter or
  Space on a focused row should open it.
- [ ] **D-REM-02 Detail.** Open a gated reminder. Expect its reason, decision
  panel, evidence, history, metadata, and any standing instruction. Evidence
  items should open and close their viewer without navigating away.
- [ ] **D-REM-03 Local Done/Later.** Mark one due reminder Done and another
  Later. Expect Done to move to Closed and Later to Someday, with new local
  copy and corrected counts. Drop it and reminder instruction editing must be
  disabled. Reload and expect both local marks to revert.

### D-REC — Recommendations

- [ ] **D-REC-01 Empty state.** On a fresh seeded database, expect the
  Recommendations heading/count copy and no invented suggestion rows.
- [ ] **D-REC-02 Populated list (conditional).** With an open recommendation in
  a disposable database, verify All, Waiting on you, Standing, and Set aside;
  grouped rows; attention badge; basis/time; and adopt/No actions.
- [ ] **D-REC-03 Answer persistence (conditional).** Adopt or decline an open
  recommendation. Expect immediate movement to Standing or Set aside, corrected
  rail/header/Activity-aside counts, and the settled state after reload. If the
  server returns 404/409/500, expect the optimistic stance to roll back.
- [ ] **D-REC-04 Detail (conditional).** Verify noticed prose, permission
  restraint, effects, metadata, and evidence. `Ask me again later` must remain
  disabled. Settled suggestions should offer Back to the list, not new answers.

### D-CAL — Calendar

- [ ] **D-CAL-01 Week/day.** Verify the range, legend for yours/my runs/
  reminders/held, seven day headers, time gutter, and today's now line. Select a
  day header or Day plus a day chip; expect only that day's blocks and counts.
- [ ] **D-CAL-02 Detail.** Open one item of each available kind. Expect the
  selected block to remain visible while detail loads, the grid to give its
  third column to the aside, and Close or clicking the selected block again to
  restore the full canvas. A detail failure should appear inside the aside.
- [ ] **D-CAL-03 Linked destinations.** Use an implemented `Where this came
  from` or action link. Expect navigation to the named workflow/reminder detail,
  not an external side effect.

### D-MEM — Things I know

- [ ] **D-MEM-01 Filter/search.** Verify a chip per memory group and its count.
  Search is case-insensitive over name, blurb, and URI. Combine a chip with a
  query, clear both, and verify the match-specific empty sentence.
- [ ] **D-MEM-02 Detail.** Open memories with fields, prose, conflict, history,
  tags, references, and sources where present. Expect URI/revision/fact count,
  provenance columns, the source file path, and honest absence of empty
  sections. Correct/Add/Forget and conflict choices must remain disabled.

## Phone cases

Use 390×844, then check 320px wide and a real device if one is available.

- [ ] **P-NAV-01 Shell.** At 699px or narrower, expect the phone frame and five
  tabs in this order: Chat, Activity, Calendar, Memory, Workflows. Calendar
  carries a `Week · Reminders` segment row under the header and Memory carries
  `Memories · Suggestions`; the second segment of each opens Reminders and
  Recommendations with the parent tab still lit. At exactly 700px, expect the
  desktop shell.
- [ ] **P-NAV-02 State per tab.** Open a Calendar, Reminder, Memory,
  Recommendation, or Workflow sheet, switch tabs, and return. Expect that tab's
  selected/open item to be retained, and a workflow sheet to return on the tab
  it was left on. Changing a list filter should close its open sheet.
- [ ] **P-NAV-04 Effects reach every screen.** From Activity, `Read the log`
  must open the Workflows sheet on Logs; a calendar reminder's `Where this came
  from` must open the Reminders screen with that reminder's sheet; an effect
  naming Recommendations must open the Suggestions screen.
- [ ] **P-NAV-03 Ask dock.** On Activity, Calendar, Memory, or Workflows, press
  the accessible `Ask Solenoid` disc. Expect focused input, blank Send to do
  nothing, Escape/Close to discard, and a nonblank send to create exactly one
  Chat conversation (one `POST /api/chat`) with the message sent into it once.
  Chat itself must not show the dock, and neither must a screen with a sheet
  open.
- [ ] **P-ACT-01 Timeline.** Expect the phone-authored lede, waiting clause in
  amber, grouped timeline, at most the prominent needs-you items carrying
  touch-sized actions, and progress (never the desktop's Open/Pause/Trace row)
  on a running entry. A local settlement must update the timeline/count and
  revert after reload. A deferred write (`Send it` on a gate whose pair carries
  a tool call) goes to the server as on the desktop: the feed re-reads with the
  outcome, and a refusal shows a `Not written` line above the timeline.
- [ ] **P-CHAT-01 List/thread.** Expect the conversation list newest first,
  Start a new one, thread back link, stored turns, and a single-line composer.
  Enter or Send submits; blank input does not. During approval the field reads
  `Answer above first`; during work it reports `Working.` and blocks another
  send. After `That turn didn't finish`, the composer must return to `Enter
  sends.` and accept the next message, and your question must not be drawn
  twice.
- [ ] **P-CAL-01 Agenda.** Change days in the seven-cell strip. Expect only the
  selected day's rows, an on-day now line, day/week restraint text, and the
  open sheet to close when the day changes. A row should open a touch-sized
  detail sheet whose Close returns to the agenda. A projected run on a later
  day must keep its sheet across a tab switch and back.
- [ ] **P-MEM-01 List/detail.** Verify group chips, grouped rows, filter empty
  copy, and a detail sheet. Tapping a fact should expand/collapse provenance.
  Memory mutation and conflict buttons must remain disabled.
- [ ] **P-REM-01 Reminders.** From Calendar, press the `Reminders` segment.
  Verify All, Needs you and Done filters, the six due buckets, row title/note/
  time/source, the attention badge, and Done / Later on every open row. A row
  opens a sheet with `Mark it done`, `Remind me later`, a disabled `Drop it`,
  the reason, the decision panel with its buttons, evidence rows that open the
  source viewer full-height and close again, history, metadata and a disabled
  instruction edit. Done must move the row to Closed and Later to Someday with
  the lede recounted; both revert on reload.
- [ ] **P-REC-01 Recommendations (conditional).** From Memory, press the
  `Suggestions` segment. On the fixture database expect the intentional empty
  sentence. With an open suggestion in a disposable database, verify All,
  Waiting on you, Standing and Set aside; the row's affirm and `No`; and a
  sheet with the two answers, a disabled `Ask me again later`, noticed prose,
  the permission panel, effects, evidence and metadata. Adopting must move the
  row to Standing at once, write `POST /api/recommendations/:id/answer`, and
  survive reload; a 404/409/500 must roll the row back.
- [ ] **P-WF-01 List/detail.** Verify horizontally scrollable filters and
  urgency groups. A detail sheet opens on Summary — summary, gate, effects,
  stats, permissions, standing instruction — with `Summary · Runs · Trace ·
  Logs` chips under its header. Pause/Resume should hold the button during the
  write, move the row after the re-read, and survive reload; restore the
  original state. On a viewport shorter than the design's 844px, every sheet's
  Close row must still be on screen.
- [ ] **P-WF-03 Runs, trace and logs.** Open Q3 vendor reconciliation. `Runs`
  lists every execution with its date, label and outcome; the newest is
  selected and its write-up, halt reason, tool calls and raw result follow the
  list. Select an older run, then open Trace and Logs: both must be about that
  same run. Expanded / Collapsed must reset the whole trace, and the tree must
  scroll inside its own box rather than widen the sheet. Log filters must show
  All, Warnings or Errors and report the visible/total count and source.
- [ ] **P-WF-04 Kill run.** Only in the disposable database, open a workflow
  with a run going and press `Kill run`. Expect `Stopping…` while the write is
  out, then the sheet re-read as stopped, the button gone, and a refusal shown
  as `That didn't take.` above the summary. Pausing a schedule must not stop
  the current execution.
- [ ] **P-WF-05 Standing instructions.** Press `Edit instructions` (or `Give
  me a rule`). Expect a 16px field with the current rule, Save disabled while
  the text is unchanged, Cancel to discard, Save to persist after the re-read
  and a reload, and clearing the text to retire the rule. Restore the original
  before leaving the case.
- [ ] **P-WF-02 Run from the sheet.** Open a design workflow: `Run it now` is
  disabled. Open Prompt-injection screen: `Run it now` is enabled and opens the
  form in the sheet, with the same fields, required marking, and defaults as
  D-WF-04, at touch height. Set Words per chunk to `0` and submit: expect the
  server's refusal inline and no run. Restore `40` and submit: expect
  `Starting…`, then `Run 1 is going now` with the header on `running` and the
  button reading `Running`, two-second re-reads without Reading flashes, and a
  terminal sheet with `What changed`, stats, and `Run it now` enabled again.

## Integration and failure checks

Run only the rows whose prerequisites exist. Use sanitized input and a
disposable target for every write.

| ID | Setup and action | Expected UI result |
| --- | --- | --- |
| F-01 API unavailable | Let Vite keep running, stop the test API, then reload. | Shell remains; initial read says it could not reach the API and names the start/seed commands. No stale data is shown. |
| F-02 Surface/detail read failure | With the home read already loaded, block one `/api/<surface>` or detail request in DevTools and open it. | The relevant main pane, aside, or sheet shows its own No answer/couldn't-open message; unrelated chrome remains usable. |
| F-03 Model/provider failure | In the disposable database, configure an unreachable model endpoint and send a harmless chat turn or run a model-backed workflow. | Chat says `That turn didn't finish`; a workflow reaches a halted state with the reason/log rather than remaining silently running. |
| F-04 Log store unavailable | Start the test server with `VICTORIALOGS_ENABLED=false`, open a seeded run's Logs tab, and change level filters. | Logs come from the run record and the source note explains that VictoriaLogs is disabled. Workflow detail remains usable. |
| F-05 Recommendation race | Open the same recommendation in two browser tabs, answer in the first, then answer in the second. | The second 409 causes its optimistic answer to roll back rather than claiming the write succeeded. |
| F-06 Shell offline | Build with `bun run build:web`, serve with `bun run start:server`, load `http://localhost:3000` online once, then use DevTools Offline and reload. | The cached shell opens; live API reads fail visibly. Network inspection shows `/api` was not served from the service worker/cache. |
| I-01 iMessage/Contacts | macOS host only; Bun must have Full Disk Access, the account needs a sanitized Messages/Contacts set, and Prompt Guard/model routes must work. Run **iMessage extraction** over a narrow known window. | The run records the exact window, distinguishes zero messages from processed/quarantined/failed conversations, and produces trace/result/log evidence. A missing grant ends as a visible workflow failure. |
| I-02 Photos read | macOS host only; `osxphotos`, Photos access, local originals/iCloud access, Prompt Guard, and the image model are required. Run **Screenshot classification** with limit 1. | One read-only run reports returned/recognized/rejected/quarantined/failed counts. No collection items are created by classification alone. |
| I-03 Collection ingestion | All I-02 prerequisites plus Tavily and an isolated app database. Run **Screenshot ingestion** with limit 1. | The run identifies saved items or explains why nothing was saved. Open Collections, verify details and screenshot provenance, then discard the test DB. No external destination is used. |
| I-04 PWA install | Production build on localhost, or HTTPS through Tailscale Serve for a phone. | Browser offers installation; installed app fills its window, uses the committed icon, honors portrait/safe areas, and still shows live API failure rather than cached data when backend access is lost. |
| I-05 Access boundary | Keep `HOST` at its default and test from the host, then optionally through an already-approved Tailscale Serve route. | Host can reach the UI/API; an ordinary LAN peer cannot reach `:3000`; a tailnet member can reach the HTTPS Serve URL. There is no app-level login. |

The recommended macOS deployment runs the server and worker directly as the
logged-in user under launchd, with Full Disk Access granted to the exact Bun
binary. In that shape iMessage, Contacts, and Photos are direct host reads; no
companion app is implemented. The older container plan includes a draft
launchd snapshot job for Messages/Contacts and proposes—but does not implement—
an HTTP bridge for `osxphotos`. The mini-cloud deployment is portable-only and
does not provide these native integrations. Do not expect a UI test against
mini-cloud to exercise I-01 through I-03.

## Accessibility and responsive basics

- [ ] **A-01 Keyboard order.** From a fresh load, use only Tab/Shift+Tab,
  Enter, Space, and Escape. Verify native buttons, links, chips, tabs, workflow/
  reminder/recommendation rows, and conversation rows are operable. Record the
  known inaccessible calendar/knowledge/agenda rows and any missing visible
  focus indicator rather than bypassing them with a mouse.
- [ ] **A-02 Names and state.** Inspect the accessibility tree. Selected rail/
  phone destinations should expose `aria-current=page`; the Ask disc should be
  named `Ask Solenoid`; the memory search should be named `Find a memory`;
  disabled actions should expose disabled state. Confirm meaningful text still
  distinguishes statuses when color is removed.
- [ ] **A-03 Zoom and reflow.** At 200% zoom and at 320px width, confirm no body
  horizontal scroll, clipped final row, hidden tab bar, or unreachable sheet
  close/action. Long titles, URIs, JSON result lines, and filter rows should
  wrap, truncate, or scroll in their own region rather than widen the page.
- [ ] **A-04 Motion and contrast.** Enable Reduce Motion and verify the running
  ring/caret stops animating while state remains understandable. Check Paper
  and Dusk text, focus, disabled, alert, and selected states with the browser's
  contrast tooling; record failures with the token/state involved.
- [ ] **A-05 Installed safe areas.** On an installed phone PWA, rotate/open with
  browser chrome expanded and collapsed. Header must clear the notch/status bar,
  tab bar must clear the home indicator, and the composer/dock must remain
  reachable as the dynamic viewport changes.

## Release smoke subset

The concise release gate is intentionally read-mostly and uses the disposable
database. Record each result; do not substitute “page loaded” for the expected
state transition.

- [ ] **S-01** `bun run build:web` succeeds, `/health` is 200, and the
  production app at `:3000` loads Activity without Console errors.
- [ ] **S-02** Desktop rail opens all seven destinations; seeded detail/back
  navigation works for Workflow, Reminder, Calendar, and Memory.
- [ ] **S-03** Activity All/Needs you/Running filters and one local decision
  settlement work; reload restores the local-only state.
- [ ] **S-04** Workflow detail switches among Summary/Executions/Trace/Logs;
  log source and filters are visible. Run-form required/400 validation works.
- [ ] **S-05** Reminder Done/Later moves rows locally and reverts on reload;
  Recommendations shows its intentional empty state on the fixture database.
- [ ] **S-06** At 390×844 all five phone tabs and both segment screens work;
  Calendar/Reminder/Memory/Recommendation/Workflow sheets open and close; the
  workflow sheet switches among Summary/Runs/Trace/Logs; the Ask dock opens,
  focuses, and cancels without send; the Prompt-injection screen's run form
  refuses `0` words per chunk inline.
- [ ] **S-07** Keyboard-open one workflow row and one conversation row; inspect
  the Ask and memory-search accessible names; capture known focus/row gaps.
- [ ] **S-08** Stop the API and reload once. The shell must remain and show a
  live API error rather than stale assistant data.
- [ ] **S-09 (configured environments only)** Complete one harmless read-only
  chat turn and confirm streamed-to-stored replacement plus reload persistence.

## Cleanup

1. Restore any workflow pause state and standing instruction changed during the
   run. Remove the `UI QA delete me` reminder through the supported test-data
   path or discard the entire disposable database.
2. Discard the isolated test collections database and exported screenshots from
   optional integration cases. Revoke temporary test tokens or connections.
3. Stop the Vite and server processes. If Tailscale Serve was enabled only for
   this run, disable it with `bun run serve:tailscale --off`.
4. Remove the exact disposable directory printed in `SOLENOID_UI_TEST_DIR` only
   after verifying it is not a real data path. Do not use a recursive delete
   against an empty variable.
5. Attach the completed evidence note to the release or defect record, with
   sensitive content redacted.
