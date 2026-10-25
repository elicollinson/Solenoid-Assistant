// Which model the chat header names. A conversation only records a model once
// voice pins one; before that the header should name whatever typed chat is
// routed to now, not a name baked into the screen.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, type Db } from "../../db";
import { markConversationVoiceInvoked, startConversation } from "../../db/mutations/chat";
import type { ChatAgent } from "../../agents/chat";
import { createChatRoutes } from "./chat";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-chat-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const noAgent = (): ChatAgent => {
  throw new Error("no turn is taken here");
};

const modelOf = async (id: string, configured: string | null) => {
  const routes = createChatRoutes(() => db, noAgent, () => configured);
  const response = await routes.handle(new Request(`http://localhost/api/chat/${id}`));
  return ((await response.json()) as { model: string | null }).model;
};

describe("the chat header's model", () => {
  test("is the configured chat model while the conversation has none of its own", async () => {
    const id = startConversation(db);
    expect(await modelOf(id, "google/gemma-4-26b-a4b-qat")).toBe("google/gemma-4-26b-a4b-qat");
  });

  test("stays the one voice pinned, whatever chat is routed to", async () => {
    const id = startConversation(db);
    markConversationVoiceInvoked(db, id, "models/gemini-live");
    expect(await modelOf(id, "google/gemma-4-26b-a4b-qat")).toBe("models/gemini-live");
  });
});
