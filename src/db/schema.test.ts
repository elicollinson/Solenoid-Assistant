// Guards on the schema itself.
//
// The seeding test doubles as documentation of the write order: an entity row
// first, then any row it points at, then the domain row. Foreign keys are NOT
// deferrable, so a reminder that names a decision needs that decision to exist.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, type Db } from "./index";
import { okfFieldId, okfFieldIds, okfObjectId, ulid } from "./ids";
import * as s from "./schema";

let dir: string;
let db: Db;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-db-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
});

afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const now = new Date();
const entity = (id: string, kind: s.EntityKind) =>
  db.insert(s.entities).values({ id, kind, createdAt: now, updatedAt: now }).run();

describe("migrations", () => {
  test("every table and view exists", () => {
    const tables = db.$client
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'
         AND name NOT LIKE 'search_%'`,
      )
      .all();
    const views = db.$client
      .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'view'`)
      .all();

    expect(tables.length).toBe(50); // 49 relational + the fts5 `search` table
    expect(views.map((v) => v.name).sort()).toEqual([
      "v_evidence",
      "v_needs_you",
      "v_okf_reads",
      "v_workflow_stats",
    ]);
  });

  // scripts/db-generate.ts adds STRICT because drizzle-kit cannot. If someone
  // runs drizzle-kit directly, this is what catches it.
  test("every relational table is STRICT", () => {
    const loose = db.$client
      .query<{ name: string; type: string; strict: number }, []>(`PRAGMA table_list`)
      .all()
      // type filters out views and the fts5 virtual table; the prefixes drop
      // SQLite internals, drizzle's journal, and the fts5 shadow tables.
      .filter(
        (t) =>
          t.type === "table" &&
          !t.name.startsWith("sqlite_") &&
          !t.name.startsWith("__drizzle") &&
          !t.name.startsWith("search_"),
      )
      .filter((t) => t.strict !== 1);

    expect(loose.map((t) => t.name)).toEqual([]);
  });

  test("foreign keys are on for this connection", () => {
    const [row] = db.$client.query<{ foreign_keys: number }, []>(`PRAGMA foreign_keys`).all();
    expect(row?.foreign_keys).toBe(1);
  });
});

describe("the spine", () => {
  // Reminder r1 from the design: the Ferris credit note, driven through every
  // cross-cutting table.
  const ids = {
    workflow: "wf_recon",
    run: "run_14",
    reminder: "rem_ferris",
    decision: "dec_ferris",
    conversation: "conv_4c02",
    message: "msg_cn0117",
    screenshot: "shot_ledger",
    okfObject: okfObjectId("okf:vendor/ferris-terms"),
  };

  test("seeds a reminder with a decision, evidence and links", () => {
    db.$client.exec("BEGIN");

    entity(ids.workflow, "workflow");
    entity(ids.run, "workflow_run");
    entity(ids.reminder, "reminder");
    entity(ids.decision, "decision");
    entity(ids.conversation, "conversation");
    entity(ids.message, "message");
    entity(ids.screenshot, "screenshot");
    entity(ids.okfObject, "okf_object");

    db.insert(s.workflows).values({
      id: ids.workflow, slug: "vendor-reconciliation",
      name: "Q3 vendor reconciliation", triggerKind: "on_demand", createdAt: now,
    }).run();

    db.insert(s.workflowRuns).values({
      id: ids.run, workflowId: ids.workflow, ordinal: 14, trigger: "manual",
      state: "attention", stepIndex: 6, stepTotal: 11, startedAt: now,
    }).run();

    // The decision is written before the reminder that names it.
    db.insert(s.decisions).values({
      id: ids.decision, subjectId: ids.reminder,
      title: "One thing needs you",
      body: "Invoices 2291 and 2318 have no ledger line.",
      state: "open", blocking: true, openedAt: now,
    }).run();

    db.insert(s.reminders).values({
      id: ids.reminder, title: "Tell Ferris whether the credit note stands",
      state: "attention", dueAt: new Date(now.getTime() - 86_400_000),
      setBy: "agent", setAt: now, originKind: "okf", originId: ids.okfObject,
      originLabel: "from okf:vendor/ferris-terms", decisionId: ids.decision,
    }).run();

    db.insert(s.actions).values([
      {
        id: ulid(), subjectId: ids.reminder, decisionId: ids.decision, ordinal: 0,
        label: "Settle it now", stance: "affirm", effectKind: "tool_call",
        effect: { tool: "reconcile.resume", args: { run: ids.run } },
        idempotencyKey: "resume-run-14", createdAt: now,
      },
      {
        id: ulid(), subjectId: ids.reminder, decisionId: ids.decision, ordinal: 1,
        label: "Keep holding", stance: "quiet", effectKind: "resolve", createdAt: now,
      },
    ]).run();

    db.insert(s.links).values({
      id: ulid(), fromId: ids.reminder, toId: ids.run, rel: "blocks",
      label: "Q3 vendor reconciliation", createdAt: now,
    }).run();

    db.insert(s.narratives).values({
      id: ulid(), subjectId: ids.reminder, slot: "account", ordinal: 0,
      text: "You told me on the 14th to leave anything Ferris alone until the credit note was settled.",
      generatedAt: now,
    }).run();

    db.insert(s.attributes).values({
      id: ulid(), subjectId: ids.reminder, groupSlot: "meta", ordinal: 0,
      label: "Blocks", value: "Q3 vendor reconciliation", valueKind: "ref", refId: ids.run,
    }).run();

    db.insert(s.subjectEvents).values({
      id: ulid(), subjectId: ids.reminder, at: now, actor: "agent", eventKind: "created",
      text: "Set this after you told me to hold the Ferris items.",
    }).run();

    db.insert(s.conversations).values({
      id: ids.conversation, channel: "email", externalId: "thread/4c02",
      title: "Credit note CN-0117", startedAt: now,
    }).run();

    const body =
      "The credit has been applied at account level. Individual invoices have not been amended.";
    db.insert(s.messages).values({
      id: ids.message, conversationId: ids.conversation, externalId: "g-1", seq: 0,
      direction: "inbound", sentAt: now, body,
    }).run();

    db.insert(s.emailMessages).values({
      messageId: ids.message, fromAddr: "accounts@ferrisproperty.co",
      toAddrs: ["you@fieldstone.co"], subject: "Credit note CN-0117",
    }).run();

    db.insert(s.screenshots).values({
      id: ids.screenshot, originalFilename: "ledger-2026-q3.png", capturedAt: now,
      capturedBy: "agent", captureContext: "captured by me from the accounts portal",
    }).run();

    // One pin on a clause, one on a whole artifact.
    const clause = "Individual invoices have not been amended.";
    db.insert(s.evidenceLinks).values([
      {
        id: ulid(), subjectId: ids.reminder, sourceId: ids.message, ordinal: 0,
        why: "This is the note itself. It never says which invoices it covers.",
        pinKind: "range", pinStart: body.indexOf(clause),
        pinEnd: body.indexOf(clause) + clause.length, pinQuote: clause, addedAt: now,
      },
      {
        id: ulid(), subjectId: ids.reminder, sourceId: ids.screenshot, ordinal: 1,
        why: "The portal has no export. It is the only record that both lines were open.",
        addedAt: now,
      },
    ]).run();

    db.$client.exec("COMMIT");

    const [reminder] = db.select().from(s.reminders).where(eq(s.reminders.id, ids.reminder)).all();
    expect(reminder?.decisionId).toBe(ids.decision);
    expect(reminder?.dueTz).toBe(s.APP_TZ);
  });

  test("v_needs_you surfaces the open decision, blocking first", () => {
    const rows = db.select().from(s.vNeedsYou).all();
    expect(rows.length).toBe(1);
    expect(rows[0]?.title).toBe("One thing needs you");
    expect(rows[0]?.blocking).toBe(true);
    expect(rows[0]?.subjectKind).toBe("reminder");
  });

  test("v_evidence joins each source to its kind", () => {
    const rows = db.select().from(s.vEvidence)
      .where(eq(s.vEvidence.subjectId, ids.reminder)).all();
    expect(rows.map((r) => [r.sourceKind, r.pinKind])).toEqual([
      ["message", "range"],
      ["screenshot", "whole"],
    ]);
    expect(rows[0]?.pinQuote).toBe("Individual invoices have not been amended.");
  });

  test("json round-trips through the effect column", () => {
    const [action] = db.select().from(s.actions)
      .where(and(eq(s.actions.decisionId, ids.decision), eq(s.actions.ordinal, 0))).all();
    expect(action?.effect).toEqual({ tool: "reconcile.resume", args: { run: ids.run } });
  });

  test("deleting the entity cascades the whole spine away", () => {
    db.delete(s.entities).where(eq(s.entities.id, ids.reminder)).run();

    expect(db.select().from(s.narratives).all().length).toBe(0);
    expect(db.select().from(s.attributes).all().length).toBe(0);
    expect(db.select().from(s.subjectEvents).all().length).toBe(0);
    expect(db.select().from(s.evidenceLinks).all().length).toBe(0);
    expect(db.select().from(s.actions).all().length).toBe(0);
    expect(db.select().from(s.links).all().length).toBe(0);
    expect(db.select().from(s.decisions).all().length).toBe(0);
    // The run it blocked is untouched.
    expect(db.select().from(s.workflowRuns).all().length).toBe(1);
  });
});

describe("constraints actually fire", () => {
  test("a dangling entity reference is rejected", () => {
    expect(() =>
      db.insert(s.decisions).values({
        id: "dec_orphan", subjectId: "no-such-entity", title: "x", openedAt: now,
      }).run(),
    ).toThrow();
  });

  test("an invalid enum value is rejected", () => {
    entity("rem_bad", "reminder");
    expect(() =>
      db.$client.run(
        `INSERT INTO reminders (id, title, state, due_tz, all_day, set_by, set_at, origin_kind)
         VALUES ('rem_bad', 'x', 'bogus', 'America/New_York', 0, 'agent', 1, 'manual')`,
      ),
    ).toThrow();
  });

  test("STRICT rejects a string written into an integer column", () => {
    expect(() =>
      db.$client.run(`INSERT INTO settings (key, value, updated_at) VALUES ('k', '1', 'not-a-time')`),
    ).toThrow();
  });

  test("the same idempotency key cannot be used twice", () => {
    entity("act_subject", "activity_item");
    const insert = (id: string, ordinal: number) =>
      db.insert(s.actions).values({
        id, subjectId: "act_subject", ordinal, label: "Send it",
        effectKind: "tool_call", idempotencyKey: "send-ferris-reply", createdAt: now,
      }).run();

    insert(ulid(), 0);
    expect(() => insert(ulid(), 1)).toThrow();
  });

  test("two live permissions for one capability cannot coexist", () => {
    entity("wf_perm", "workflow");
    db.insert(s.workflows).values({
      id: "wf_perm", slug: "perm-test", name: "Perm test",
      triggerKind: "schedule", createdAt: now,
    }).run();

    const insert = (id: string, mode: "allow" | "ask") =>
      db.insert(s.workflowPermissions).values({
        id, workflowId: "wf_perm", capability: "spend_money", mode, createdAt: now,
      }).run();

    insert("perm_1", "ask");
    expect(() => insert("perm_2", "allow")).toThrow();

    // Retiring the first frees the capability.
    db.update(s.workflowPermissions)
      .set({ retiredAt: now })
      .where(eq(s.workflowPermissions.id, "perm_1"))
      .run();
    expect(() => insert("perm_3", "allow")).not.toThrow();
  });

  test("a calendar item may have no state, but not an invented one", () => {
    entity("cal_ok", "calendar_item");
    expect(() =>
      db.insert(s.calendarItems).values({
        id: "cal_ok", kind: "run", title: "inbox-triage", startsAt: now,
      }).run(),
    ).not.toThrow();

    entity("cal_bad", "calendar_item");
    expect(() =>
      db.$client.run(
        `INSERT INTO calendar_items (id, kind, state, title, starts_at, tz, all_day, status, provider, set_by)
         VALUES ('cal_bad', 'run', 'idle', 'x', 1, 'America/New_York', 0, 'confirmed', 'local', 'user')`,
      ),
    ).toThrow();
  });
});

describe("full-text search", () => {
  test("indexes and finds a message body", () => {
    db.$client.run(
      `INSERT INTO search (title, body, subject_id, kind, occurred_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        "Credit note CN-0117",
        "The credit has been applied at account level. Individual invoices have not been amended.",
        "msg_cn0117",
        "message",
        now.getTime(),
      ],
    );

    const hits = db.$client
      .query<{ subject_id: string }, [string]>(
        `SELECT subject_id FROM search WHERE search MATCH ? ORDER BY rank`,
      )
      .all("amended");

    expect(hits.map((h) => h.subject_id)).toEqual(["msg_cn0117"]);
  });

  test("stems, so 'invoice' finds 'invoices'", () => {
    const hits = db.$client
      .query<{ subject_id: string }, [string]>(`SELECT subject_id FROM search WHERE search MATCH ?`)
      .all("invoice");
    expect(hits.length).toBe(1);
  });
});

describe("okf ids are stable across a reindex", () => {
  test("the same uri always yields the same object id", () => {
    expect(okfObjectId("okf:contact/ferris")).toBe(okfObjectId("okf:contact/ferris"));
    expect(okfObjectId("okf:contact/ferris")).not.toBe(okfObjectId("okf:contact/marta"));
  });

  test("a field id survives reordering but not a change of value", () => {
    const uri = "okf:contact/ferris";
    const before = okfFieldIds(uri, [
      { label: "legal name", value: "Ferris Vale Ltd" },
      { label: "billing address", value: "17 Ferrier Row" },
    ]);
    // Same fields, different order in the markdown.
    const after = okfFieldIds(uri, [
      { label: "billing address", value: "17 Ferrier Row" },
      { label: "legal name", value: "Ferris Vale Ltd" },
    ]);
    expect(after).toEqual([before[1]!, before[0]!]);

    // A new value is a new assertion, so it is a new id.
    expect(okfFieldId(uri, "billing address", "Unit 3, Calder Yard")).not.toBe(before[1]);
  });

  test("two fields with the same label and value get distinct ids", () => {
    const ids = okfFieldIds("okf:contact/ferris", [
      { label: "note", value: "same" },
      { label: "note", value: "same" },
    ]);
    expect(new Set(ids).size).toBe(2);
  });

  test("hashing cannot be fooled by shifting a separator", () => {
    expect(okfFieldId("okf:x", "ab", "c")).not.toBe(okfFieldId("okf:x", "a", "bc"));
  });

  test("evidence attached to a field survives a re-index of that object", () => {
    const uri = "okf:policy/quarter-boundary";
    const objectId = okfObjectId(uri);
    const [fieldId] = okfFieldIds(uri, [{ label: "threshold", value: "$50" }]);

    entity(objectId, "okf_object");
    entity(fieldId!, "okf_field");
    entity("msg_rule", "message");
    entity("conv_rule", "conversation");

    db.insert(s.okfObjects).values({
      id: objectId, uri, path: "okf/policy/quarter-boundary.md",
      title: "Quarter-boundary differences", createdAt: now, updatedAt: now, indexedAt: now,
    }).run();
    db.insert(s.okfFields).values({
      id: fieldId!, objectId, ordinal: 0, label: "threshold", value: "$50",
      provenance: "user",
    }).run();
    db.insert(s.conversations).values({
      id: "conv_rule", channel: "agent_chat", externalId: "chat/61b4", startedAt: now,
    }).run();
    db.insert(s.messages).values({
      id: "msg_rule", conversationId: "conv_rule", seq: 0, direction: "inbound",
      sentAt: now, body: "Make it $50. Anything under that, just book it.",
    }).run();
    db.insert(s.evidenceLinks).values({
      id: ulid(), subjectId: fieldId!, sourceId: "msg_rule", ordinal: 0,
      why: "The only change since. I moved the number and left the rule as it was.",
      addedAt: now,
    }).run();

    // A re-index rebuilds the projection: delete the field row and write it back
    // from the file, deriving the id the same way.
    db.delete(s.okfFields).where(eq(s.okfFields.id, fieldId!)).run();
    const [rederived] = okfFieldIds(uri, [{ label: "threshold", value: "$50" }]);
    expect(rederived).toBe(fieldId);

    db.insert(s.okfFields).values({
      id: rederived!, objectId, ordinal: 0, label: "threshold", value: "$50",
      provenance: "user",
    }).run();

    // The evidence link still resolves, because it points at the entity row,
    // which the projection rebuild never touched.
    const evidence = db.select().from(s.vEvidence)
      .where(eq(s.vEvidence.subjectId, fieldId!)).all();
    expect(evidence.length).toBe(1);
    expect(evidence[0]?.sourceKind).toBe("message");
  });

  test("okf_access_log outlives the projection it describes", () => {
    const uri = "okf:policy/quarter-boundary";
    db.insert(s.okfAccessLog).values([
      { okfUri: uri, objectId: okfObjectId(uri), at: now, mode: "read" },
      { okfUri: uri, objectId: okfObjectId(uri), at: now, mode: "read" },
    ]).run();

    // A full reindex drops okf_objects; the log has no FK into it on purpose.
    db.delete(s.okfObjects).where(eq(s.okfObjects.uri, uri)).run();

    const [reads] = db.select().from(s.vOkfReads).where(eq(s.vOkfReads.okfUri, uri)).all();
    expect(reads?.readCount).toBe(2);
  });
});

describe("ulid", () => {
  test("sorts by creation order, including within one millisecond", () => {
    const at = Date.now();
    const ids = Array.from({ length: 50 }, () => ulid(at));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
    expect(ids[0]).toHaveLength(26);
  });

  test("ids minted later sort after ids minted earlier", () => {
    expect(ulid(1_000) < ulid(2_000)).toBe(true);
  });
});

describe("workflow stats view", () => {
  test("counts runs and clean runs per workflow", () => {
    entity("wf_stats", "workflow");
    db.insert(s.workflows).values({
      id: "wf_stats", slug: "digest", name: "Weekly digest",
      triggerKind: "schedule", createdAt: now,
    }).run();

    const runs: { ordinal: number; state: "done" | "failed"; durationMs: number }[] = [
      { ordinal: 1, state: "done", durationMs: 300_000 },
      { ordinal: 2, state: "done", durationMs: 372_000 },
      { ordinal: 3, state: "failed", durationMs: 291_000 },
    ];
    for (const r of runs) {
      const id = `run_stats_${r.ordinal}`;
      entity(id, "workflow_run");
      db.insert(s.workflowRuns).values({
        id, workflowId: "wf_stats", ordinal: r.ordinal, trigger: "schedule",
        state: r.state, startedAt: now, durationMs: r.durationMs,
      }).run();
    }

    const [stats] = db.select().from(s.vWorkflowStats)
      .where(eq(s.vWorkflowStats.workflowId, "wf_stats")).all();

    expect(stats?.runs).toBe(3);
    expect(stats?.cleanRuns).toBe(2);
    expect(stats?.medianDurationMs).toBe(300_000);
  });
});

describe("a chat with the agent is a conversation", () => {
  // The morning the design draws: two turns of prose with an approval standing
  // between them, and the approval about something that exists elsewhere.
  const ids = {
    workflow: "wf_permit",
    run: "run_permit",
    reminder: "rem_permit",
    decision: "dec_permit",
    conversation: "conv_today",
    turns: ["msg_t0", "msg_t1", "msg_t2", "msg_t3"],
  };

  test("seeds a transcript with an approval standing in it", () => {
    db.$client.exec("BEGIN");

    entity(ids.workflow, "workflow");
    entity(ids.run, "workflow_run");
    entity(ids.reminder, "reminder");
    entity(ids.decision, "decision");
    entity(ids.conversation, "conversation");
    for (const id of ids.turns) entity(id, "message");

    db.insert(s.workflows).values({
      id: ids.workflow, slug: "inbox-triage", name: "Inbox triage",
      triggerKind: "schedule", createdAt: now,
    }).run();
    db.insert(s.workflowRuns).values({
      id: ids.run, workflowId: ids.workflow, ordinal: 212, trigger: "schedule",
      state: "running", stepIndex: 6, stepTotal: 11, startedAt: now,
    }).run();
    db.insert(s.reminders).values({
      id: ids.reminder, title: "Renew the parking permit", state: "attention",
      setBy: "agent", setAt: now, originKind: "conversation",
    }).run();
    // The decision is about the permit, not about the turn it was raised in.
    db.insert(s.decisions).values({
      id: ids.decision, subjectId: ids.reminder,
      title: "Renew the parking permit on the council portal",
      body: "Renewing early costs nothing and doesn't shorten the term, so the only reason to wait is that it spends your money.",
      blocking: true, openedAt: now,
    }).run();

    db.insert(s.conversations).values({
      id: ids.conversation, channel: "agent_chat", externalId: "chat/today",
      title: "This morning's approvals", startedAt: now, lastMessageAt: now,
    }).run();

    const turn = (id: string, seq: number, direction: "inbound" | "outbound", body: string) =>
      db.insert(s.messages).values({
        id, conversationId: ids.conversation, seq, direction, sentAt: now, body,
        sentBy: direction === "outbound" ? "user" : "agent",
      }).run();

    turn(ids.turns[0]!, 0, "outbound", "Morning. Anything I need to look at?");
    turn(ids.turns[1]!, 1, "inbound", "Two things, both small.");
    turn(ids.turns[2]!, 2, "inbound", "Renew the parking permit on the council portal");
    turn(ids.turns[3]!, 3, "inbound", "Still matching invoices while we talk.");

    db.insert(s.agentTurns).values([
      // The bubble: a decision fixed at a point in the stream.
      { messageId: ids.turns[2]!, decisionId: ids.decision },
      // The meter and the inline tool calls are the run's, not the turn's.
      {
        messageId: ids.turns[3]!, runId: ids.run,
        toolSummary: "3 tool calls · docs.read, web.form_walk, calendar.check",
        note: "written to okf:policy/ferris-hold · rev 1",
      },
    ]).run();

    // The agent's own words on the buttons, and what followed once settled.
    db.insert(s.actions).values([
      {
        id: "act_permit_yes", subjectId: ids.decision, decisionId: ids.decision, ordinal: 0,
        label: "Renew it for me", stance: "affirm", effectKind: "tool_call", createdAt: now,
      },
      {
        id: "act_permit_no", subjectId: ids.decision, decisionId: ids.decision, ordinal: 1,
        label: "I'll do it myself", stance: "quiet", effectKind: "resolve", createdAt: now,
      },
    ]).run();
    db.insert(s.narratives).values([
      {
        id: ulid(), subjectId: ids.decision, slot: "restraint", ordinal: 0,
        text: "The form is filled and unsent. Nothing is committed.", generatedAt: now,
      },
      {
        id: ulid(), subjectId: ids.decision, slot: "outcome", ordinal: 0,
        text: "You said renew it, 11:23. Paid £84 and filed the confirmation.", generatedAt: now,
      },
    ]).run();

    db.$client.exec("COMMIT");

    const stream = db.select().from(s.messages)
      .where(eq(s.messages.conversationId, ids.conversation))
      .orderBy(s.messages.seq).all();
    expect(stream.map((m) => m.seq)).toEqual([0, 1, 2, 3]);

    const [bubble] = db.select().from(s.agentTurns)
      .where(eq(s.agentTurns.messageId, ids.turns[2]!)).all();
    expect(bubble?.decisionId).toBe(ids.decision);
  });

  test("the meter is read off the run rather than frozen into the turn", () => {
    const [row] = db
      .select({ index: s.workflowRuns.stepIndex, total: s.workflowRuns.stepTotal })
      .from(s.agentTurns)
      .innerJoin(s.workflowRuns, eq(s.agentTurns.runId, s.workflowRuns.id))
      .where(eq(s.agentTurns.messageId, ids.turns[3]!))
      .all();
    expect(`${row?.index}/${row?.total}`).toBe("6/11");

    db.update(s.workflowRuns).set({ stepIndex: 9 })
      .where(eq(s.workflowRuns.id, ids.run)).run();
    const [moved] = db.select({ index: s.workflowRuns.stepIndex }).from(s.agentTurns)
      .innerJoin(s.workflowRuns, eq(s.agentTurns.runId, s.workflowRuns.id))
      .where(eq(s.agentTurns.messageId, ids.turns[3]!)).all();
    expect(moved?.index).toBe(9);
  });

  test("one decision cannot be asked twice in the same transcript", () => {
    entity("msg_dup", "message");
    db.insert(s.messages).values({
      id: "msg_dup", conversationId: ids.conversation, seq: 4, direction: "inbound",
      sentAt: now, body: "Renew the parking permit on the council portal",
    }).run();
    expect(() =>
      db.insert(s.agentTurns).values({ messageId: "msg_dup", decisionId: ids.decision }).run(),
    ).toThrow();
  });

  test("losing what was decided about does not lose the turn that asked", () => {
    // The reminder goes; its decision cascades away with it.
    db.delete(s.entities).where(eq(s.entities.id, ids.reminder)).run();
    expect(db.select().from(s.decisions).where(eq(s.decisions.id, ids.decision)).all().length).toBe(0);

    const [turn] = db.select().from(s.agentTurns)
      .where(eq(s.agentTurns.messageId, ids.turns[2]!)).all();
    expect(turn).toBeDefined();
    expect(turn?.decisionId).toBeNull();
    // And the ask is still readable, because it was never only in the decision.
    const [message] = db.select().from(s.messages).where(eq(s.messages.id, ids.turns[2]!)).all();
    expect(message?.body).toBe("Renew the parking permit on the council portal");
  });

  test("deleting the conversation takes its turns and their extensions", () => {
    db.delete(s.entities).where(eq(s.entities.id, ids.conversation)).run();
    expect(db.select().from(s.messages)
      .where(eq(s.messages.conversationId, ids.conversation)).all().length).toBe(0);
    expect(db.select().from(s.agentTurns).all().length).toBe(0);
  });
});

describe("what I run on", () => {
  test("there is no column a key could be read back out of", () => {
    const columns = db.$client
      .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('secrets')`)
      .all()
      .map((c) => c.name);
    expect(columns).toEqual([
      "key", "label", "storage", "ref", "held", "hint", "need",
      "set_at", "set_by", "last_used_at", "last_used_ok", "retired_at",
    ]);
    // `hint` is the only thing resembling a key, and it is four characters.
    expect(() =>
      db.insert(s.secrets).values({
        key: "bad.key", label: "Bad", hint: "sk-live-9f2c41", setAt: now,
      }).run(),
    ).toThrow();
  });

  test("a route names the key it cannot run without, and outlives it", () => {
    db.insert(s.secrets).values([
      { key: "openai.apiKey", label: "LM Studio", ref: "OPENAI_API_KEY", held: true, hint: "4b1e", setAt: now },
      {
        key: "openrouter.apiKey", label: "OpenRouter", ref: "OPENROUTER_API_KEY", held: false,
        need: "Route two cannot run without it.",
      },
    ]).run();

    db.insert(s.modelRoutes).values([
      {
        id: "rt1", ordinal: 0, provider: "openai", model: "qwen/qwen3.5-9b", strategy: "native",
        note: "LM Studio on the desk machine. Nothing leaves the house on this one.",
        secretKey: "openai.apiKey", createdAt: now, updatedAt: now,
      },
      {
        id: "rt2", ordinal: 1, provider: "openrouter", model: "google/gemma-4-31b-it",
        strategy: "native", secretKey: "openrouter.apiKey", createdAt: now, updatedAt: now,
      },
      // Null strategy is the screen's "as it comes".
      { id: "rt3", ordinal: 2, provider: "ollama", model: "glm-5.2:cloud", createdAt: now, updatedAt: now },
    ]).run();

    // "Route two is skipped rather than tried" is worked out, not narrated.
    const skipped = db.$client
      .query<{ id: string }, []>(
        `SELECT r.id FROM model_routes r JOIN secrets s ON s.key = r.secret_key WHERE s.held = 0`,
      )
      .all();
    expect(skipped.map((r) => r.id)).toEqual(["rt2"]);

    db.delete(s.secrets).where(eq(s.secrets.key, "openrouter.apiKey")).run();
    const [orphan] = db.select().from(s.modelRoutes).where(eq(s.modelRoutes.id, "rt2")).all();
    expect(orphan?.secretKey).toBeNull();
  });

  test("two routes cannot claim the same place in the chain", () => {
    expect(() =>
      db.insert(s.modelRoutes).values({
        id: "rt4", ordinal: 0, provider: "ollama", model: "x", createdAt: now, updatedAt: now,
      }).run(),
    ).toThrow();
  });

  test("last week's failovers survive deleting the route that caused them", () => {
    db.insert(s.routeAttempts).values([
      { id: ulid(), routeId: "rt2", at: now, outcome: "skipped", reason: "no key held", nextRouteId: "rt3" },
      { id: ulid(), routeId: "rt1", at: now, outcome: "failed", reason: "connection refused", nextRouteId: "rt2" },
      { id: ulid(), routeId: "rt3", at: now, outcome: "ok", durationMs: 4_120 },
    ]).run();

    db.delete(s.modelRoutes).where(eq(s.modelRoutes.id, "rt2")).run();

    const attempts = db.select().from(s.routeAttempts).all();
    expect(attempts.length).toBe(3);
    expect(attempts.filter((a) => a.outcome !== "ok").length).toBe(2);
    // The row survived; only the name it pointed at is gone.
    expect(attempts.find((a) => a.outcome === "skipped")?.routeId).toBeNull();
  });

  test("a setting says where its value came from, and what it is not", () => {
    db.insert(s.settings).values([
      { key: "port", value: 3000, source: "user", updatedAt: now, updatedBy: "user" },
      {
        key: "promptGuard.threshold", value: 0.5, source: "default", updatedAt: now,
        hint: "Below this I let a prompt through.",
      },
      { key: "notion.ds.music", value: null, source: "default", updatedAt: now },
    ]).run();

    const rows = new Map(db.select().from(s.settings).all().map((r) => [r.key, r]));
    // Nothing here yet is a state, not an absence.
    expect(rows.get("notion.ds.music")?.value).toBeNull();
    expect(rows.get("port")?.source).toBe("user");
    expect(rows.get("promptGuard.threshold")?.source).toBe("default");

    expect(() =>
      db.$client.run(
        `INSERT INTO settings (key, value, source, updated_at) VALUES ('x', '1', 'seeded', 1)`,
      ),
    ).toThrow();
  });

  test("a check hangs off the setting that names what was reached", () => {
    db.insert(s.connectionChecks).values([
      { id: ulid(), settingKey: "notion.ds.music", at: now, kind: "read", ok: true, latencyMs: 38 },
    ]).run();
    db.delete(s.settings).where(eq(s.settings.key, "notion.ds.music")).run();
    expect(db.select().from(s.connectionChecks).all().length).toBe(0);
  });
});

describe("the line about a screen", () => {
  const today = "2026-08-25";

  test("two screens can each hold today's restraint", () => {
    db.insert(s.surfaceNotes).values([
      {
        id: ulid(), screen: "calendar", surface: "desktop", slot: "restraint", onDate: today,
        text: "I have not touched anything after six this evening.", generatedAt: now,
      },
      {
        id: ulid(), screen: "chat", surface: "desktop", slot: "restraint", onDate: today,
        text: "Nothing has gone out since 09:39.", generatedAt: now,
      },
      {
        id: ulid(), screen: "chat", surface: "phone", slot: "restraint", onDate: today,
        text: "Nothing has gone out since 09:39.", generatedAt: now,
      },
    ]).run();

    expect(db.select().from(s.surfaceNotes).all().length).toBe(3);
  });

  test("but one screen holds one of each", () => {
    expect(() =>
      db.insert(s.surfaceNotes).values({
        id: ulid(), screen: "chat", surface: "desktop", slot: "restraint", onDate: today,
        text: "A second one.", generatedAt: now,
      }).run(),
    ).toThrow();
  });

  test("a line about the screen rather than a day is held once, undated", () => {
    db.insert(s.surfaceNotes).values({
      id: ulid(), screen: "settings", surface: "desktop", slot: "gate_body",
      text: "OpenRouter has no key, so route two is skipped rather than tried.",
      generatedAt: now,
    }).run();

    expect(() =>
      db.insert(s.surfaceNotes).values({
        id: ulid(), screen: "settings", surface: "desktop", slot: "gate_body",
        text: "A second one.", generatedAt: now,
      }).run(),
    ).toThrow();

    // The dated index does not stop it, because a null date is not a date.
    expect(() =>
      db.insert(s.surfaceNotes).values({
        id: ulid(), screen: "settings", surface: "desktop", slot: "gate_body", onDate: today,
        text: "True of today only.", generatedAt: now,
      }).run(),
    ).not.toThrow();
  });

  test("an invented screen is rejected", () => {
    expect(() =>
      db.$client.run(
        `INSERT INTO surface_notes (id, screen, surface, slot, text, generated_at)
         VALUES ('sn_bad', 'inbox', 'desktop', 'line', 'x', 1)`,
      ),
    ).toThrow();
  });
});
