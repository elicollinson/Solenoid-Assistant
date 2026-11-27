// First-class SQLite skills store, built-in seeding, `skills` tool group,
// `GET /api/chat/skills` route, and end-to-end `SessionCoordinator` integration
// (direct `/<slug>` invocation + autonomous `open_skill` discovery).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppSettingsSchema,
  OPEN_SKILL,
  createHarness,
  toolName,
  type ChatMessage,
  type ChatOptions,
  type ChatProvider,
} from "@elicollinson/solenoid-engine";
import { createChatProfile } from "../agents/chat";
import { SessionCoordinator } from "../chat/coordinator";
import { DrizzleCheckpointStore } from "./chatCheckpoints";
import { createDb, runMigrations, type Db } from "./index";
import { startConversation } from "./mutations/chat";
import {
  DrizzleSkillStore,
  InvalidSkillSlugError,
  NoSuchSkillError,
  SkillAlreadyExistsError,
  createSkill,
  deleteSkill,
  ensureBuiltinSkills,
  getSkillBySlug,
  listSkills,
  updateSkill,
} from "./skills";
import { createChatRoutes } from "../http/routes/chat";
import type { ChatEvent } from "../shared/chat";
import { compileToolGroup } from "../tools/groupAdapter";
import { skillsGroup } from "../tools/skills";

type ScriptStep =
  | ChatMessage
  | ((messages: ChatMessage[], opts: ChatOptions) => ChatMessage | Promise<ChatMessage>);

class ScriptedProvider implements ChatProvider {
  readonly providerName = "scripted";
  readonly calls: ChatMessage[][] = [];
  readonly offered: string[][] = [];

  constructor(private readonly steps: ScriptStep[]) {}

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatMessage> {
    this.calls.push(messages.map((m) => ({ ...m })));
    this.offered.push(opts.tools.map((t) => t.function.name));
    const step = this.steps.shift();
    if (!step) throw new Error(`ScriptedProvider exhausted at call ${this.calls.length}`);
    const msg = typeof step === "function" ? await step(messages, opts) : step;
    if (msg.content) opts.onDelta?.({ type: "text", text: msg.content });
    return msg;
  }
}

class EventCollector {
  readonly events: ChatEvent[] = [];
  private readonly waiters: Array<{
    predicate: (event: ChatEvent) => boolean;
    resolve: (event: ChatEvent) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  readonly listener = (event: ChatEvent): void => {
    this.events.push(event);
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const waiter = this.waiters[i]!;
      if (waiter.predicate(event)) {
        clearTimeout(waiter.timer);
        this.waiters.splice(i, 1);
        waiter.resolve(event);
      }
    }
  };

  waitFor<T extends ChatEvent = ChatEvent>(
    predicate: (event: ChatEvent) => event is T,
    timeoutMs = 5_000,
    fromIndex = 0,
  ): Promise<T> {
    for (let i = fromIndex; i < this.events.length; i++) {
      const existing = this.events[i]!;
      if (predicate(existing)) return Promise.resolve(existing);
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for ChatEvent (seen: ${this.events.map((e) => e.type).join(", ")})`));
      }, timeoutMs);
      this.waiters.push({
        predicate,
        resolve: resolve as (event: ChatEvent) => void,
        reject,
        timer,
      });
    });
  }
}

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-skills-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("SQLite skills store and built-in seeding", () => {
  test("ensureBuiltinSkills seeds intro and create-skill once without overwriting user edits", () => {
    const first = ensureBuiltinSkills(db);
    expect(first.added).toBe(2);

    const listed = listSkills(db);
    expect(listed.map((s) => s.slug)).toEqual(["create-skill", "intro"]);
    expect(listed.every((s) => s.source === "builtin" && s.enabled && s.slashCommand)).toBe(true);
    expect(getSkillBySlug(db, "create-skill")?.toolGroups).toEqual(["skills"]);
    expect(getSkillBySlug(db, "intro")?.toolGroups).toEqual(["workflows", "skills"]);

    // User customizes a built-in skill; re-running ensureBuiltinSkills leaves it untouched.
    updateSkill(db, "intro", { title: "My custom intro", description: "Custom intro description." });
    const second = ensureBuiltinSkills(db);
    expect(second.added).toBe(0);
    expect(getSkillBySlug(db, "intro")?.title).toBe("My custom intro");
    expect(getSkillBySlug(db, "intro")?.description).toBe("Custom intro description.");
  });

  test("CRUD mutations validate slugs, guard built-ins from deletion, and update live DrizzleSkillStore", () => {
    ensureBuiltinSkills(db);
    const store = new DrizzleSkillStore(db);

    expect(() =>
      createSkill(db, {
        slug: "Not Valid!",
        title: "Bad",
        description: "Bad slug",
        instructions: "Nope",
      }),
    ).toThrow(InvalidSkillSlugError);

    const created = createSkill(db, {
      slug: "Morning-Brief",
      title: "Morning briefing",
      description: "Summarize today's schedule and reminders.",
      instructions: "Check calendar and reminders, then write a concise morning summary.",
      toolGroups: ["calendar", "reminders", "calendar"],
    });
    expect(created.slug).toBe("morning-brief");
    expect(created.toolGroups).toEqual(["calendar", "reminders"]);
    expect(created.source).toBe("user");
    expect(store.get("morning-brief")?.title).toBe("Morning briefing");

    // Duplicate slug rejected.
    expect(() =>
      createSkill(db, {
        slug: "morning-brief",
        title: "Dup",
        description: "Dup",
        instructions: "Dup",
      }),
    ).toThrow(SkillAlreadyExistsError);

    // Disabling hides from store.list()/get()/listSlashCommands() while keeping row inspectable.
    updateSkill(db, "morning-brief", { enabled: false });
    expect(store.get("morning-brief")).toBeUndefined();
    expect(store.list().map((s) => s.name)).not.toContain("morning-brief");
    expect(store.listSlashCommands().map((s) => s.name)).not.toContain("morning-brief");
    expect(getSkillBySlug(db, "morning-brief", { includeDisabled: true })?.enabled).toBe(false);

    // Turning slashCommand off hides from slash picker while keeping enabled for open_skill.
    updateSkill(db, "morning-brief", { enabled: true, slashCommand: false });
    expect(store.get("morning-brief")).toBeDefined();
    expect(store.listSlashCommands().map((s) => s.name)).not.toContain("morning-brief");

    // Built-ins cannot be deleted, user skills can.
    expect(() => deleteSkill(db, "intro")).toThrow(/cannot be deleted/i);
    expect(deleteSkill(db, "morning-brief")).toEqual({ slug: "morning-brief", deleted: true });
    expect(() => deleteSkill(db, "morning-brief")).toThrow(NoSuchSkillError);
  });
});

describe("skills tool group & GET /api/chat/skills route", () => {
  test("skillsGroup exposes read + write tools and strips writes cleanly in readOnly mode", async () => {
    ensureBuiltinSkills(db);
    const context = { db, okf: { root: join(dir, "okf"), actor: "skills/test" } };
    const full = compileToolGroup(skillsGroup(context), { readOnly: false });
    const ro = compileToolGroup(skillsGroup(context), { readOnly: true });

    expect(full.tools.map(toolName)).toEqual([
      "skills_list",
      "skills_get",
      "skills_create",
      "skills_update",
      "skills_delete",
    ]);
    expect(ro.tools.map(toolName)).toEqual(["skills_list", "skills_get"]);
    expect(ro.briefing).not.toContain("skills_create");
    expect(ro.briefing).not.toContain("skills_update");
    expect(ro.briefing).not.toContain("skills_delete");

    const listTool = full.tools.find((t) => toolName(t) === "skills_list")!;
    const createTool = full.tools.find((t) => toolName(t) === "skills_create")!;
    const getTool = full.tools.find((t) => toolName(t) === "skills_get")!;
    const toolCtx = {
      signal: new AbortController().signal,
      offered: new Map(),
      messages: [],
      commit() {},
    };

    const initialList = (await listTool.execute({}, toolCtx)) as {
      skills: Array<{ slug: string }>;
    };
    expect(initialList.skills.map((s) => s.slug)).toEqual(["create-skill", "intro"]);

    const created = (await createTool.execute(
      {
        slug: "trip-prep",
        title: "Trip prep",
        description: "Assemble a checklist before travel.",
        instructions: "Inspect calendar and reminders for the trip window.",
        toolGroups: ["calendar", "reminders"],
        slashCommand: true,
      },
      toolCtx,
    )) as { created: boolean; slug: string };
    expect(created).toMatchObject({ created: true, slug: "trip-prep" });

    const fetched = (await getTool.execute({ slug: "trip-prep" }, toolCtx)) as {
      found: boolean;
      skill: { instructions: string; toolGroups: string[] };
    };
    expect(fetched.found).toBe(true);
    expect(fetched.skill.toolGroups).toEqual(["calendar", "reminders"]);
    expect(fetched.skill.instructions).toContain("calendar and reminders");
  });

  test("GET /api/chat/skills returns enabled slash-invocable skills only", async () => {
    ensureBuiltinSkills(db);
    createSkill(db, {
      slug: "silent-skill",
      title: "Background only",
      description: "Loaded autonomously only.",
      instructions: "Run quietly.",
      slashCommand: false,
    });
    createSkill(db, {
      slug: "disabled-skill",
      title: "Off",
      description: "Disabled skill.",
      instructions: "Off.",
      enabled: false,
    });

    const routes = createChatRoutes(() => db, () => {
      throw new Error("no agent needed");
    });
    const res = await routes.handle(new Request("http://localhost/api/chat/skills"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      skills: Array<{ name: string; title: string; description: string; source: string }>;
    };
    expect(body.skills.map((s) => s.name)).toEqual(["create-skill", "intro"]);
    expect(body.skills[0]?.title.length).toBeGreaterThan(0);
    expect(body.skills[0]?.description.length).toBeGreaterThan(0);
  });
});

describe("SessionCoordinator end-to-end skill invocation & autonomous open_skill", () => {
  test("direct /intro and /create-skill slash commands inject skill instructions and unlock paired tool groups", async () => {
    ensureBuiltinSkills(db);
    const provider = new ScriptedProvider([
      { role: "assistant", content: "Here is what Solenoid can do for you." },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tc-list-1", name: "skills_list", arguments: {} }],
      },
      { role: "assistant", content: "I checked your existing skills — ready to design weekly-digest." },
    ]);

    const settings = AppSettingsSchema.parse({
      screening: { enabled: false },
      checkpoints: { enabled: true },
      device: { id: "server-1", name: "solenoid-server" },
    });
    const harness = await createHarness(settings, {
      checkpointStore: new DrizzleCheckpointStore(db),
      routes: [{ client: provider, model: "scripted-chat" }],
      screener: null,
      baseTools: [],
    });
    const context = { db, okf: { root: join(dir, "okf"), actor: "chat/test" } };
    const coordinator = new SessionCoordinator({
      db,
      harness,
      profileFactory: () =>
        createChatProfile(context, {
          routes: [{ client: provider, model: "scripted-chat" }],
          canSpawn: false,
          screening: false,
        }),
    });

    const conversationId = startConversation(db);
    const collector = new EventCollector();
    const unsub = coordinator.subscribe(conversationId, collector.listener);

    try {
      // Turn 1: /intro injects built-in intro skill context without mutating messages[0].
      await coordinator.send(conversationId, "/intro");
      const firstMsg = await collector.waitFor(
        (e): e is Extract<ChatEvent, { type: "message" }> => e.type === "message",
      );
      expect(firstMsg.body).toBe("Here is what Solenoid can do for you.");

      const turn1Messages = provider.calls[0]!;
      expect(turn1Messages[0]?.role).toBe("system");
      const turn1User = turn1Messages.findLast((m) => m.role === "user");
      expect(String(turn1User?.content)).toContain("intro");
      expect(String(turn1User?.content)).toContain("explicitly invoked");
      expect(provider.offered[0]).toContain(OPEN_SKILL);

      // Turn 2: /create-skill unlocks the paired `skills` tool group immediately on Turn 1!
      const fromIdx = collector.events.length;
      await coordinator.send(conversationId, "/create-skill weekly digest");
      const secondMsg = await collector.waitFor(
        (e): e is Extract<ChatEvent, { type: "message" }> => e.type === "message",
        5_000,
        fromIdx,
      );
      expect(secondMsg.body).toContain("weekly-digest");

      // messages[0] stayed byte-identical across turns (KV-cache prefix preserved).
      expect(provider.calls[1]![0]?.content).toBe(turn1Messages[0]?.content);
      // Paired `skills` tools were unlocked immediately for `/create-skill`.
      expect(provider.offered[1]).toContain("skills_list");
      expect(provider.offered[1]).toContain("skills_create");
    } finally {
      unsub();
      await coordinator.close();
    }
  });

  test("autonomous open_skill loads instructions, unlocks paired tools, and emits opened 'skill:<slug>'", async () => {
    ensureBuiltinSkills(db);
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tc-open-skill", name: OPEN_SKILL, arguments: { skill: "create-skill" } }],
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tc-skills-list", name: "skills_list", arguments: {} }],
      },
      { role: "assistant", content: "Let's draft your new reusable skill together." },
    ]);

    const settings = AppSettingsSchema.parse({
      screening: { enabled: false },
      checkpoints: { enabled: true },
      device: { id: "server-1", name: "solenoid-server" },
    });
    const harness = await createHarness(settings, {
      checkpointStore: new DrizzleCheckpointStore(db),
      routes: [{ client: provider, model: "scripted-chat" }],
      screener: null,
      baseTools: [],
    });
    const context = { db, okf: { root: join(dir, "okf"), actor: "chat/test" } };
    const coordinator = new SessionCoordinator({
      db,
      harness,
      profileFactory: () =>
        createChatProfile(context, {
          routes: [{ client: provider, model: "scripted-chat" }],
          canSpawn: false,
          screening: false,
        }),
    });

    const conversationId = startConversation(db);
    const collector = new EventCollector();
    const unsub = coordinator.subscribe(conversationId, collector.listener);

    try {
      await coordinator.send(conversationId, "Can we build a reusable skill for my Monday prep?");
      const finalMsg = await collector.waitFor(
        (e): e is Extract<ChatEvent, { type: "message" }> => e.type === "message",
      );

      // Before open_skill, `skills_list` is not offered yet; right after open_skill it IS offered!
      expect(provider.offered[0]).toContain(OPEN_SKILL);
      expect(provider.offered[0]).not.toContain("skills_list");
      expect(provider.offered[1]).toContain("skills_list");
      expect(provider.offered[1]).toContain("skills_create");

      // Translator emitted `opened` for `skill:create-skill`, formatted note cleanly, and excluded open_skill from calls.
      expect(
        collector.events.some((e) => e.type === "opened" && e.group === "skill:create-skill"),
      ).toBe(true);
      expect(finalMsg.note).toBe("opened skill create-skill");
      expect(finalMsg.toolSummary).toContain("skills.list");
      expect(finalMsg.toolSummary).not.toContain("open_skill");
    } finally {
      unsub();
      await coordinator.close();
    }
  });
});
