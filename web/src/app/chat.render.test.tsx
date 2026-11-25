// The whole path in one test: a real conversation written by the real
// mutations → the chat query → the two screens the design asks for.
//
// The transcript is built by writing rows the way ../../../src/chat/session.ts
// writes them, rather than by hand, so a column renamed on the server fails
// here instead of in a browser. What it is checking is narrow and specific:
// that an approval is drawn with its buttons while it is open, that it keeps
// its place and loses them once answered, and that a write tool's arguments
// reach the person being asked to approve them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createDb, runMigrations, type Db } from "../../../src/db";
import { loadChat, loadConversations } from "../../../src/db/queries/chat";
import {
  appendAgentMessage,
  appendUserMessage,
  openApproval,
  settleApproval,
  startConversation,
} from "../../../src/db/mutations/chat";
import { zonedTime } from "../../../src/db/seed/time";
import type { ChatApproval, ChatListPayload, ChatPayload, ChatTurnRow } from "../../../src/shared/chat";
import { ChatView } from "./ChatView";
import { ChatPhone } from "./phone/ChatPhone";
import type { VoiceModeState } from "./useVoiceMode";
import type { ChatState, LiveTurn } from "./chat";

let dir: string;
let db: Db;
let conversationId: string;

const MORNING = zonedTime(2026, 8, 25, 9, 20);
const noop = () => {};

/** The hook's return value, without the hook. The screens take this whole. */
function stateFor(
  payload: ChatPayload | null,
  list: ChatListPayload,
  live: LiveTurn | null = null,
): ChatState {
  return {
    status: "ready",
    message: "",
    conversations: list.conversations,
    openId: payload?.conversationId ?? null,
    title: payload?.title ?? null,
    model: payload?.model ?? null,
    voiceInvoked: payload?.voiceInvoked ?? false,
    stored: payload?.turns ?? [],
    lede: (payload ?? list).lede,
    restraint: (payload ?? list).restraint,
    waiting: list.waiting,
    live,
    open: noop,
    start: async () => null,
    send: noop,
    answer: noop,
    reload: noop,
  };
}

const EMPTY_LIVE: LiveTurn = {
  asked: "",
  said: [],
  calls: [],
  opened: [],
  pending: null,
  error: null,
};

const voice: VoiceModeState = {
  active: false, status: "idle", isSpeaking: false, isWorking: false, extendedThinking: true, toggleExtendedThinking: noop, isMuted: false,
  error: null, analyserNode: null, startVoice: async () => {}, stopVoice: noop, toggleMute: noop,
};

const desktop = (state: ChatState) => renderToStaticMarkup(<ChatView chat={state} voice={voice} />);
const phone = (state: ChatState) => renderToStaticMarkup(<ChatPhone chat={state} voice={voice} onTab={noop} />);

/** The two payloads a screen needs, read together as the client reads them. */
const both = (live: LiveTurn | null = null) =>
  stateFor(loadChat(db, conversationId, MORNING), loadConversations(db, MORNING), live);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-chat-render-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  conversationId = startConversation(db, MORNING);
});

afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a plain exchange", () => {
  test("draws both halves with the same treatment, and the agent's machine facts", () => {
    appendUserMessage(db, conversationId, "what did you do overnight?", MORNING);
    appendAgentMessage(
      db,
      conversationId,
      "I read the overnight mail and filed two things.",
      { toolSummary: "3 tool calls · imessage.list_conversations ×2, okf.read", note: "written to okf:policy/ferris-hold · rev 1" },
      MORNING,
    );

    const markup = desktop(both());
    expect(markup).toContain("what did you do overnight?");
    expect(markup).toContain("I read the overnight mail and filed two things.");
    // Both sides are named in the mono gutter; neither is a bubble.
    expect(markup).toContain("You");
    expect(markup).toContain("Solenoid");
    // The ×2 collapse survives to the page.
    expect(markup).toContain("imessage.list_conversations ×2");
    expect(markup).toContain("okf:policy/ferris-hold");
  });
});

describe("an approval", () => {
  let decisionId: string;
  let goAheadId: string;

  beforeAll(() => {
    const opened = openApproval(
      db,
      {
        conversationId,
        title: "Put a 90-minute hold on Thursday morning.",
        facts: [
          ["Call", "calendar.hold"],
          ["title", "Ferris walkthrough"],
          ["startAt", "2026-08-27T09:00:00-04:00"],
        ],
        choices: [
          { label: "Go ahead", stance: "affirm", approves: true },
          { label: "Not this one", stance: "quiet", approves: false },
        ],
      },
      MORNING,
    );
    decisionId = opened.decisionId;
    goAheadId = opened.actions.find((action) => action.stance === "affirm")!.id;
  });

  test("open, it draws the ask, the literal call and both buttons", () => {
    const payload = loadChat(db, conversationId, MORNING);
    expect(payload.waiting).toBe(1);

    for (const markup of [desktop(both()), phone(both())]) {
      expect(markup).toContain("Needs you");
      // The short reference you could read out, top-right of the bubble.
      expect(markup).toMatch(/ap\/\d{4}-\d+/);
      expect(markup).toContain("Put a 90-minute hold on Thursday morning.");
      // The receipt under the account: which Thursday, and what it is called.
      expect(markup).toContain("calendar.hold");
      expect(markup).toContain("Ferris walkthrough");
      expect(markup).toContain("2026-08-27T09:00:00-04:00");
      expect(markup).toContain("Go ahead");
      expect(markup).toContain("Not this one");
    }
  });

  test("answered, it keeps its place and says what you chose", () => {
    settleApproval(db, decisionId, { actionId: goAheadId, outcome: "approved" }, MORNING);
    const payload = loadChat(db, conversationId, MORNING);
    expect(payload.waiting).toBe(0);

    const markup = desktop(both());
    // Still there — the turn after it answers a question the page must show.
    expect(markup).toContain("Put a 90-minute hold on Thursday morning.");
    expect(markup).toContain("Settled");
    expect(markup).toContain('You said &quot;Go ahead&quot;.');
    // The buttons are gone, not disabled.
    expect(markup).not.toContain("Not this one");
  });
});

describe("a turn in flight", () => {
  test("draws what you asked before the server has it, and what it is doing", () => {
    const live: LiveTurn = {
      ...EMPTY_LIVE,
      asked: "hold thursday morning for the walkthrough",
      said: ["I'll put a 90-minute hold on Thursday."],
      opened: ["calendar"],
      calls: [{ name: "calendar.list", arg: "Aug 24 – 30", duration: "0.4s", kind: "read", ok: true }],
    };
    const markup = desktop(both(live));

    expect(markup).toContain("hold thursday morning for the walkthrough");
    // The sentence before the act, which is what the approval under it answers.
    expect(markup).toContain("I&#x27;ll put a 90-minute hold on Thursday.");
    expect(markup).toContain("calendar.list");
    expect(markup).toContain("opened calendar");
    expect(markup).toContain("still writing");
  });

  test("a failed turn says so where the answer would have been", () => {
    const live: LiveTurn = { ...EMPTY_LIVE, asked: "go on", error: "the model route chain failed" };
    const markup = desktop(both(live));
    expect(markup).toContain("That turn didn&#x27;t finish");
    expect(markup).toContain("the model route chain failed");
    // No caret: the turn is over, it just ended badly.
    expect(markup).not.toContain("still writing");
  });
});

describe("the phone is not the desktop narrower", () => {
  test("your words are a bubble and its own are not", () => {
    const small = phone(both());
    // The bubble: bordered, on a raised surface, and narrower than the column.
    expect(small).toContain("max-width:30ch");
    // The agent's prose is none of that — no 30ch anywhere near its turn.
    expect(small).toContain("Solenoid");
    expect(small).toContain("You");
  });

  test("Chat is a tab now, and the bar carries all five", () => {
    const small = phone(both());
    for (const label of ["Chat", "Activity", "Calendar", "Memory", "Workflows"]) {
      expect(small).toContain(label);
    }
  });

  test("the thread has a way back to the list", () => {
    expect(phone(both())).toContain("Conversations");
  });
});

describe("the model in the header", () => {
  test("is the one the server names, on both screens, not a name baked in", () => {
    const state = { ...both(), model: "google/gemma-4-26b-a4b-qat" };
    for (const markup of [desktop(state), phone(state)]) {
      expect(markup).toContain("gemma-4-26b-a4b-qat");
      expect(markup).not.toContain("google/");
      expect(markup).not.toContain("Gemma 4");
    }
  });
});

// ---------------------------------------------------------------------------
// Surface 8 target render contracts: streaming, running tools, subagents,
// deferred approvals, voice provenance, and React Compiler kit hygiene.
// ---------------------------------------------------------------------------

function isolatedState(overrides: Partial<ChatState> = {}): ChatState {
  return {
    status: "ready",
    message: "",
    conversations: [
      { id: "conv-render", title: "Weekly check-in", lede: "", when: "09:20", state: "idle" },
    ],
    openId: "conv-render",
    title: "Weekly check-in",
    model: "google/gemma-4-26b-a4b-qat",
    voiceInvoked: false,
    stored: [],
    lede: "",
    restraint: null,
    waiting: 0,
    live: null,
    open: noop,
    start: async () => null,
    send: noop,
    answer: noop,
    reload: noop,
    ...overrides,
  };
}

function visibleText(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ");
}

function desktopTextareaTag(markup: string): string {
  return markup.match(/<textarea\b[^>]*>/)?.[0] ?? "";
}

function phoneInputTag(markup: string): string {
  return markup.match(/<input\b[^>]*name="say"[^>]*>/)?.[0] ?? "";
}

describe("streaming and live execution on desktop and phone", () => {
  test("renders streaming partial reply (live.streamingText) on both desktop and phone", () => {
    const live: LiveTurn = {
      ...EMPTY_LIVE,
      turnId: "t-stream-1",
      source: "text",
      asked: "Summarize the week",
      streamingText: "Here is the summary so far, still streaming token by token.",
    };
    const state = isolatedState({ live });

    for (const markup of [desktop(state), phone(state)]) {
      expect(markup).toContain("Summarize the week");
      expect(markup).toContain("Here is the summary so far, still streaming token by token.");
      expect(markup).toContain("still writing");
    }
  });

  test("renders running tool indicator (status: 'running') on both desktop and phone", () => {
    const live: LiveTurn = {
      ...EMPTY_LIVE,
      turnId: "t-tool-1",
      source: "text",
      asked: "Check my calendar",
      calls: [
        {
          id: "call-running-1",
          name: "calendar.list",
          arg: "next 7 days",
          duration: "",
          kind: "read",
          ok: true,
          status: "running",
        },
      ],
    };
    const state = isolatedState({ live });

    for (const markup of [desktop(state), phone(state)]) {
      expect(markup).toContain("calendar.list");
      expect(markup).toContain("next 7 days");
      // Must show an explicit running indicator (running text/attribute or kit's green running ring).
      expect(markup).toMatch(/running|var\(--signal-green\)/i);
    }
  });
});

describe("background subagents and synthesis turns on desktop and phone", () => {
  test("renders active background subagent status on both desktop and phone", () => {
    const live: LiveTurn = {
      ...EMPTY_LIVE,
      activeSubagents: [
        {
          id: "sa-1",
          name: "calendar-researcher",
          status: "running",
          current: "checking August availability",
        },
      ],
    };
    const state = isolatedState({ live });

    for (const markup of [desktop(state), phone(state)]) {
      expect(markup).toContain("calendar-researcher");
      expect(markup).toContain("checking August availability");
    }
  });

  test("renders live subagent synthesis turn (source: 'subagent') without drawing an empty user bubble", () => {
    const live: LiveTurn = {
      ...EMPTY_LIVE,
      turnId: "t-auto-1",
      source: "subagent",
      asked: "",
      streamingText: "Synthesizing findings from calendar-researcher.",
    };
    const state = isolatedState({ live });

    for (const markup of [desktop(state), phone(state)]) {
      expect(markup).toContain("Synthesizing findings from calendar-researcher.");
      expect(visibleText(markup)).toMatch(/\bsubagent\b|\bbackground\b/i);
      // Async auto-turn has no user prompt and must not draw an empty "You" bubble.
      expect(markup).not.toContain(">You<");
    }
  });

  test("renders stored subagent synthesis turn (source: 'subagent') with provenance on both screens", () => {
    const makeTurn = (source: "subagent" | "text"): ChatTurnRow => ({
      id: "turn-sub-1",
      by: "agent",
      body: "Research agent compiled three options for Thursday.",
      at: "09:42",
      note: null,
      toolSummary: null,
      calls: [],
      approval: null,
      source,
    });
    const subagentState = isolatedState({ stored: [makeTurn("subagent")] });
    const textState = isolatedState({ stored: [makeTurn("text")] });

    for (const render of [desktop, phone]) {
      const subagentMarkup = render(subagentState);
      const textMarkup = render(textState);
      expect(subagentMarkup).toContain("Research agent compiled three options for Thursday.");
      expect(subagentMarkup).not.toBe(textMarkup);
      expect(visibleText(subagentMarkup)).toMatch(/\bsubagent\b|\bbackground\b/i);
    }
  });
});

describe("deferred subagent approval bubble on desktop and phone", () => {
  test("renders live deferred approval with actionable buttons while composer stays enabled", () => {
    const live: LiveTurn = {
      ...EMPTY_LIVE,
      pending: null,
      deferredApprovals: [
        {
          type: "deferred_approval",
          decisionId: "dec-def-render-1",
          ref: "ap/0825-9",
          title: "Add Friday dentist reminder.",
          why: "Creates a reminder in Reminders.",
          hold: "Nothing has been written yet.",
          tool: "reminders.create",
          subagentName: "planner",
          facts: [
            ["Call", "reminders.create"],
            ["title", "Dentist"],
          ],
          actions: [
            { id: "act-def-yes", label: "Go ahead", stance: "affirm" },
            { id: "act-def-no", label: "Not this one", stance: "quiet" },
          ],
        },
      ],
    };
    const state = isolatedState({ live });

    const desktopMarkup = desktop(state);
    const phoneMarkup = phone(state);

    for (const markup of [desktopMarkup, phoneMarkup]) {
      expect(markup).toContain("ap/0825-9");
      expect(markup).toContain("Add Friday dentist reminder.");
      expect(markup).toContain("reminders.create");
      expect(markup).toContain("Dentist");
      expect(markup).toContain("planner");
      expect(markup).toContain("Go ahead");
      expect(markup).toContain("Not this one");
      // Must NOT lock the composer like a blocking parent approval does.
      expect(markup).not.toContain("Answer above first");
      expect(markup).not.toContain("Waiting on your answer above.");
    }

    // Verify composer input itself is present and not disabled.
    expect(desktopTextareaTag(desktopMarkup)).not.toBe("");
    expect(desktopTextareaTag(desktopMarkup)).not.toMatch(/\bdisabled\b/);
    expect(phoneInputTag(phoneMarkup)).not.toBe("");
    expect(phoneInputTag(phoneMarkup)).not.toMatch(/\bdisabled\b/);
  });

  test("renders stored deferred approval bubble on both screens while composer stays enabled", () => {
    const deferred: ChatApproval = {
      decisionId: "dec-def-stored-1",
      ref: "ap/0825-10",
      title: "File hotel confirmation to OKF.",
      why: "Writes a memory note.",
      hold: "Nothing has been written yet.",
      facts: [
        ["Call", "okf.write"],
        ["slug", "trip/boston-hotel"],
      ],
      choices: [
        { id: "act-stored-yes", label: "Go ahead", stance: "affirm" },
        { id: "act-stored-no", label: "Not this one", stance: "quiet" },
      ],
      state: "open",
      chosenId: null,
      settled: null,
      deferred: true,
      subagentName: "travel-helper",
    };
    const storedTurn: ChatTurnRow = {
      id: "turn-def-1",
      by: "agent",
      body: "The travel subagent finished and queued one optional write.",
      at: "09:45",
      note: null,
      toolSummary: null,
      calls: [],
      approval: null,
      source: "subagent",
      deferredApprovals: [deferred],
    };
    const state = isolatedState({ stored: [storedTurn], live: null });

    const desktopMarkup = desktop(state);
    const phoneMarkup = phone(state);

    for (const markup of [desktopMarkup, phoneMarkup]) {
      expect(markup).toContain("ap/0825-10");
      expect(markup).toContain("File hotel confirmation to OKF.");
      expect(markup).toContain("okf.write");
      expect(markup).toContain("travel-helper");
      expect(markup).toContain("Go ahead");
      expect(markup).toContain("Not this one");
      expect(markup).not.toContain("Answer above first");
    }
    expect(desktopTextareaTag(desktopMarkup)).not.toBe("");
    expect(desktopTextareaTag(desktopMarkup)).not.toMatch(/\bdisabled\b/);
    expect(phoneInputTag(phoneMarkup)).not.toBe("");
    expect(phoneInputTag(phoneMarkup)).not.toMatch(/\bdisabled\b/);
  });

  test("contrasts blocking parent approval which still locks the composer on both screens", () => {
    const blockingLive: LiveTurn = {
      ...EMPTY_LIVE,
      asked: "Book Thursday hold",
      pending: {
        type: "approval",
        decisionId: "dec-block-render",
        ref: "ap/0825-11",
        title: "Book Thursday hold.",
        why: "Creates a calendar event.",
        hold: "Nothing has been written.",
        tool: "calendar.create",
        facts: [["Call", "calendar.create"]],
        actions: [
          { id: "act-b-yes", label: "Go ahead", stance: "affirm" },
          { id: "act-b-no", label: "Not this one", stance: "quiet" },
        ],
      },
    };
    const state = isolatedState({ live: blockingLive });
    const desktopMarkup = desktop(state);
    const phoneMarkup = phone(state);

    expect(desktopMarkup).toContain("Answer above first");
    expect(desktopTextareaTag(desktopMarkup)).toMatch(/\bdisabled\b/);
    expect(phoneMarkup).toContain("Answer above first");
    expect(phoneInputTag(phoneMarkup)).toMatch(/\bdisabled\b/);
  });
});

describe("voice-originated turn indicator (source: 'voice') on desktop and phone", () => {
  test("distinguishes voice turns from text turns in the transcript on both screens", () => {
    const makeTurns = (source: "voice" | "text"): ChatTurnRow[] => [
      {
        id: "turn-v-1",
        by: "user",
        body: "Remind me to call Sam at 5",
        at: "09:30",
        note: null,
        toolSummary: null,
        calls: [],
        approval: null,
        source,
      },
      {
        id: "turn-v-2",
        by: "agent",
        body: "Got it, I'll remind you at 5.",
        at: "09:30",
        note: null,
        toolSummary: null,
        calls: [],
        approval: null,
        source,
      },
    ];

    const voiceState = isolatedState({ stored: makeTurns("voice") });
    const textState = isolatedState({ stored: makeTurns("text") });

    for (const render of [desktop, phone]) {
      const voiceMarkup = render(voiceState);
      const textMarkup = render(textState);

      expect(voiceMarkup).toContain("Remind me to call Sam at 5");
      expect(voiceMarkup).toContain("Got it, I&#x27;ll remind you at 5.");
      // Voice turns must render a visible provenance indicator in the transcript beyond the composer button.
      expect(voiceMarkup).not.toBe(textMarkup);
      const voiceMatches = voiceMarkup.match(/\bvoice\b|\bspoken\b/gi)?.length ?? 0;
      const textMatches = textMarkup.match(/\bvoice\b|\bspoken\b/gi)?.length ?? 0;
      expect(voiceMatches).toBeGreaterThan(textMatches);
    }
  });
});

describe("design-kit React Compiler hygiene", () => {
  function collectKitSourceFiles(dirPath: string): string[] {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        files.push(...collectKitSourceFiles(fullPath));
      } else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
    return files;
  }

  test("web/src/kit/ contains zero manual useMemo, useCallback, or React.memo", () => {
    const kitDir = join(import.meta.dir, "../kit");
    const sourceFiles = collectKitSourceFiles(kitDir);
    expect(sourceFiles.length).toBeGreaterThan(10);

    const violations: string[] = [];
    for (const file of sourceFiles) {
      const content = readFileSync(file, "utf8");
      if (/\b(?:useMemo|useCallback)\b|\bReact\.memo\b/.test(content)) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });
});
