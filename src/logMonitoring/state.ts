import { randomUUID } from "node:crypto";
import type { Db } from "../db";

export interface IncidentState { status: string; issueNumber: number | null; issueUrl: string | null }
export class MonitorState {
  constructor(readonly db: Db, readonly scope: string) {}
  acquire(now: number) {
    const owner = randomUUID();
    return this.db.$client.transaction(() => {
      this.db.$client.query("INSERT OR IGNORE INTO log_monitor_scans(scope) VALUES(?)").run(this.scope);
      const result = this.db.$client.query("UPDATE log_monitor_scans SET owner=?,lease_until=? WHERE scope=? AND lease_until<=?")
        .run(owner, now + 120000, this.scope, now);
      if (!result.changes) {
        const held = this.db.$client.query("SELECT lease_until FROM log_monitor_scans WHERE scope=?").get(this.scope) as { lease_until: number };
        throw new Error(`Another log scan holds the lease (concurrent scan). Wait for it to finish; if it stops renewing, this lease expires at ${new Date(held.lease_until).toISOString()}. No scan was started by this request.`);
      }
      const row = this.db.$client.query("SELECT completed_to FROM log_monitor_scans WHERE scope=?").get(this.scope) as { completed_to: number | null };
      return { owner, completedTo: row.completed_to };
    }).immediate();
  }
  window(owner: string, from: number, to: number) {
    this.db.$client.query("UPDATE log_monitor_scans SET pending_from=COALESCE(pending_from,?),pending_to=COALESCE(pending_to,?) WHERE scope=? AND owner=?").run(from, to, this.scope, owner);
    return this.db.$client.query("SELECT pending_from AS fromTime,pending_to AS toTime FROM log_monitor_scans WHERE scope=? AND owner=?").get(this.scope, owner) as { fromTime: number; toTime: number };
  }
  unresolved(): number {
    return (this.db.$client.query("SELECT COUNT(*) AS n FROM log_monitor_incidents WHERE scope=? AND status='posting'").get(this.scope) as { n: number }).n;
  }
  renew(owner: string, now = Date.now()) {
    const result = this.db.$client.query("UPDATE log_monitor_scans SET lease_until=? WHERE scope=? AND owner=? AND lease_until>?")
      .run(now + 120000, this.scope, owner, now);
    if (!result.changes) throw new Error("Log scan lease lost");
  }
  complete(owner: string, to: number, now = Date.now()) {
    const result = this.db.$client.query("UPDATE log_monitor_scans SET completed_to=MAX(COALESCE(completed_to,0),?),owner=NULL,lease_until=0,pending_from=NULL,pending_to=NULL WHERE scope=? AND owner=? AND lease_until>?")
      .run(to, this.scope, owner, now);
    if (!result.changes) throw new Error("Log scan lease lost before checkpoint");
  }
  release(owner: string) {
    this.db.$client.query("UPDATE log_monitor_scans SET owner=NULL,lease_until=0 WHERE scope=? AND owner=?").run(this.scope, owner);
  }
  incident(id: string): IncidentState | null {
    return this.db.$client.query("SELECT status,issue_number AS issueNumber,issue_url AS issueUrl FROM log_monitor_incidents WHERE scope=? AND fingerprint=?")
      .get(this.scope, id) as IncidentState | null;
  }
  reserve(ids: string[]) {
    // Committed before the HTTP request. A crash leaves 'posting', never an
    // automatic retry of a request that may already have created an issue.
    this.db.$client.transaction(() => {
      for (const id of ids) this.db.$client.query("INSERT INTO log_monitor_incidents(scope,fingerprint,status) VALUES(?,?,'posting')").run(this.scope, id);
    }).immediate();
  }
  link(ids: string[], issue: { number: number; url: string }) {
    this.db.$client.transaction(() => {
      for (const id of ids) this.db.$client.query("INSERT INTO log_monitor_incidents(scope,fingerprint,status,issue_number,issue_url) VALUES(?,?,'linked',?,?) ON CONFLICT(scope,fingerprint) DO UPDATE SET status='linked',issue_number=excluded.issue_number,issue_url=excluded.issue_url")
        .run(this.scope, id, issue.number, issue.url);
    }).immediate();
  }
}
