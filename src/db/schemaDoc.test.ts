import { describe, expect, test } from "bun:test";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { describeTable, type ColumnNotes } from "./schemaDoc";
import * as s from "./schema";

const parent = sqliteTable("parent", { id: text().primaryKey() });

const widget = sqliteTable("widget", {
  id: text().primaryKey().references(() => parent.id),
  title: text().notNull(),
  status: text({ enum: ["open", "closed"] }).notNull().default("open"),
  weight: integer(),
  internalCursor: text(),
});

const notes: ColumnNotes<typeof widget> = {
  id: "The widget's id.",
  title: "What it is called.",
  status: "Closing is final.",
  weight: null,
  internalCursor: null,
};

describe("describeTable", () => {
  test("reads type, nullability, default and enum members off the column", () => {
    const fields = describeTable(widget, notes);
    const byName = new Map(fields.map((field) => [field.name, field]));

    expect(byName.get("title")).toMatchObject({
      type: "text",
      required: true,
      note: "What it is called.",
    });
    expect(byName.get("status")).toMatchObject({
      type: "one of: open | closed",
      default: '"open"',
    });
  });

  // A column with a default is not something a caller must supply, whatever the
  // NOT NULL says.
  test("a defaulted column is not required", () => {
    const status = describeTable(widget, notes).find((f) => f.name === "status");
    expect(status?.required).toBe(false);
  });

  test("omits the columns the notes hide", () => {
    const names = describeTable(widget, notes).map((field) => field.name);
    expect(names).toEqual(["id", "title", "status"]);
  });

  test("resolves what a column points at", () => {
    const id = describeTable(widget, notes).find((field) => field.name === "id");
    expect(id?.references).toBe("parent.id");
  });

  test("keeps declaration order", () => {
    const names = describeTable(widget, { ...notes, weight: "How heavy.", internalCursor: "x" })
      .map((field) => field.name);
    expect(names).toEqual(["id", "title", "status", "weight", "internalCursor"]);
  });

  // The reason this file exists: the notes are a mapped type over the table's
  // own select model, so a column added upstream is a compile error until it is
  // documented or explicitly hidden. Nothing here can assert that at runtime —
  // `bun run typecheck` is the assertion — but this keeps it exercised against
  // a real, wide table rather than only the fixture above.
  test("describes a real table from the running schema", () => {
    const fields = describeTable(s.recommendations, {
      id: "The suggestion's id.",
      title: "The suggestion itself, phrased as the thing you would do.",
      status: "The three shelves are read off this and never stored.",
      confidence: "How sure you are, while it is still being asked.",
      formedAt: "When it was formed.",
      decidedAt: null,
      decidedBy: null,
      basisLabel: "What it rests on, counted in your own unit.",
      basisCount: null,
      basisRunCount: null,
      scopeLabel: null,
      scopeOkfUri: null,
      scopeWorkflowId: "The workflow it would change, when it would change one.",
      decisionId: null,
      reRaiseCondition: null,
      reRaiseAfter: null,
      appliedPermissionId: null,
      appliedInstructionId: null,
    });

    const byName = new Map(fields.map((field) => [field.name, field]));
    expect(byName.get("status")).toMatchObject({
      type: "one of: proposed | adopted | declined | withdrawn | superseded",
      required: false,
      default: '"proposed"',
    });
    expect(byName.get("formedAt")?.type).toBe("timestamp");
    expect(byName.get("scopeWorkflowId")?.references).toBe("workflows.id");
    expect(byName.get("decidedAt")).toBeUndefined();
  });
});

describe("SQL defaults", () => {
  // Stringifying a `sql` default spills Drizzle's query builder into the
  // briefing: {"decoder":{},"shouldInlineParams":false,"queryChunks":[...]}.
  test("renders the literal text rather than the query builder", () => {
    const field = describeTable(s.actions, {
      id: null, activityItemId: null, decisionId: null, reminderId: null,
      recommendationId: null, calendarItemId: null, workflowId: null,
      label: "What the button says.",
      kind: null, effectKind: null,
      effect: "The payload the button carries.",
      ordinal: null, state: null, chosenAt: null, chosenBy: null,
    } as never).find((f) => f.name === "effect");

    expect(field?.default).toBe("'{}'");
    expect(field?.default).not.toContain("queryChunks");
  });
});
