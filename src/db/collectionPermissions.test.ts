import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { createDb, runMigrations } from "./index";
import * as s from "./schema";
import { syncWorkflowCatalog } from "../workflows/sync";
import { resolvePermission } from "../workflows/permissions";

for (const scope of ["workflow", "global"] as const) {
  for (const mode of ["allow", "deny", "ask", "revoked"] as const) {
    test(`migration preserves ${scope} ${mode} after catalog sync`, () => {
      const dir = mkdtempSync(join(tmpdir(), "collection-permissions-"));
      const db = createDb(":memory:");
      try {
        mkdirSync(join(dir, "meta"));
        const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
        journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 9);
        writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify(journal));
        for (const entry of journal.entries) copyFileSync(`drizzle/${entry.tag}.sql`, join(dir, `${entry.tag}.sql`));
        runMigrations(db, dir);
        syncWorkflowCatalog(db, new Date(), { registerOnly: true });
        const workflowId = db.select().from(s.workflows).where(eq(s.workflows.slug, "screenshot-ingestion")).get()!.id;
        const now = new Date();
        const rule = { workflowId: scope === "global" ? null : workflowId, capability: "notion.write", createdAt: now, createdBy: "user" as const };
        db.insert(s.workflowPermissions).values([
          { ...rule, id: "old-history", mode: "allow", retiredAt: now },
          { ...rule, id: "old-current", mode: mode === "revoked" ? "allow" : mode, retiredAt: mode === "revoked" ? now : null },
        ]).run();
        runMigrations(db);
        syncWorkflowCatalog(db);
        syncWorkflowCatalog(db);
        expect(resolvePermission(db, workflowId, "collections.write")).toEqual({
          mode: mode === "revoked" ? "ask" : mode,
          scope: mode === "revoked" ? "default" : scope,
        });
        const copied = db.select().from(s.workflowPermissions).where(eq(s.workflowPermissions.capability, "collections.write")).all();
        expect(copied).toHaveLength(2);
        expect(copied.every((row) => row.createdBy === "user")).toBe(true);
        expect(db.select().from(s.workflowPermissions).where(eq(s.workflowPermissions.capability, "notion.write")).all()).toHaveLength(2);
      } finally { db.$client.close(); rmSync(dir, { recursive: true, force: true }); }
    });
  }
}
