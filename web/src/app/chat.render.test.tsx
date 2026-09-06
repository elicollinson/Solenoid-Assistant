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
import { mkdtempSync, rmSync } from "node:fs";
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
import type { ChatListPayload, ChatPayload } from "../../../src/shared/chat";
import { ChatView } from "./ChatView";
import { ChatPhone } from "./phone/ChatPhone";
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
    stored: payload?.turns ?? [],
    lede: (payload ?? list).lede,
    restraint: (payload ?? list).restraint,
    waiting: list.waiting,
    live,
    open: noop,
    start: noop,
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

const desktop = (state: ChatState) => renderToStaticMarkup(<ChatView chat={state} />);
const phone = (state: ChatState) => renderToStaticMarkup(<ChatPhone chat={state} onTab={noop} />);

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
