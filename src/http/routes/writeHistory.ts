import { Elysia } from "elysia";
import { timingSafeEqual } from "node:crypto";
import { historyRuntime, type HistoryRuntime } from "../../writeHistory/runtime";
import { HistoryConflict, HistoryUnavailable } from "../../writeHistory/history";
import { DreamWorkflow, type DreamNeighbors, dreamPlanSchema } from "../../workflows/dream";
import { resolvePermission } from "../../workflows/permissions";

export function createWriteHistoryRoutes(resolveRuntime: () => HistoryRuntime = historyRuntime,
  token: () => string | undefined = () => process.env.WRITE_HISTORY_TOKEN,
  neighbors?: DreamNeighbors, dreamEnabled = () => process.env.DREAM_ENABLED === "true") {
  function authorized(request: Request) {
    const configured = token(), supplied = request.headers.get("authorization") ?? "";
    if (!configured || configured.length < 32) return false;
    const a = Buffer.from(supplied), b = Buffer.from(`Bearer ${configured}`);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    const origin = request.headers.get("origin");
    return !origin || origin === new URL(request.url).origin;
  }
  function requireDream() { if (!dreamEnabled()) throw new HistoryConflict("Memory reflection is disabled. Configure DREAM_ENABLED explicitly before preparing or applying dream proposals."); }
  function permitDream(runtime: HistoryRuntime) {
    const row = runtime.history.db.$client.query("SELECT id FROM workflows WHERE slug='okf-reflection'").get() as { id: string } | null;
    if (resolvePermission(runtime.history.db, row?.id, "okf.write").mode === "deny") throw new HistoryConflict("Current permission denies memory reflection");
  }
  function permit(runtime: HistoryRuntime, capability: string, operationId?: string | null) {
    const row = operationId ? runtime.history.db.$client.query("SELECT workflow_id FROM write_operations WHERE id=?").get(operationId) as { workflow_id: string | null } | null : null;
    if (resolvePermission(runtime.history.db, row?.workflow_id ?? undefined, capability).mode === "deny") throw new HistoryConflict(`Current permission denies ${capability}`);
  }
  const run = (fn: (r: HistoryRuntime, request: Request, params: Record<string, string>) => unknown | Promise<unknown>) =>
    async ({ request, params }: { request: Request; params: Record<string, string> }) => {
      if (!authorized(request)) return new Response("Unauthorized", { status: 401 });
      try { return await fn(resolveRuntime(), request, params); }
      catch (e) { return new Response(JSON.stringify({ error: e instanceof HistoryConflict || e instanceof HistoryUnavailable ? e.message : "History operation failed; inspect its recorded outcome before retrying" }),
        { status: e instanceof HistoryConflict ? 409 : 400, headers: { "content-type": "application/json", "cache-control": "no-store" } }); }
    };
  return new Elysia({ name: "routes.write-history" })
    .onAfterHandle(({ set }) => { set.headers["cache-control"] = "no-store"; })
    .get("/api/write-history", run((r, request) => {
      const before = Number(new URL(request.url).searchParams.get("before") ?? Number.MAX_SAFE_INTEGER);
      return { captureEnabled: r.captureEnabled, rows: r.history.list(Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER),
        coverage: ["Agent and voice tool dispatch", "Deferred write tools", "OKF store (capture enabled)", "Simple reminder field revisions (capture enabled)"] };
    }))
    .get("/api/write-history/:id", run((r, _request, { id }) => {
      const row = r.history.get(id!); if (!row) return new Response("Not found", { status: 404 });
      let captured: unknown = null;
      try { captured = r.history.payload(id!); } catch { /* Metadata survives expiration. */ }
      return { ...row, events: r.history.events(id!), captured };
    }))
    .post("/api/write-history/:id/reversal-plans", run(async (r, _request, { id }) => {
      const payload = r.history.payload<{ kind: string }>(id!);
      return payload.kind === "okf-v1" ? r.files.planInverse(id!) : r.rows.planInverse(id!);
    }))
    .get("/api/write-plans", run(r => ({ plans: r.history.db.$client.query("SELECT id,kind,digest,state,created_at AS createdAt FROM write_plans WHERE state='proposed' AND expires_at>? ORDER BY created_at DESC LIMIT 50").all(r.history.now()) })))
    .get("/api/write-plans/:id", run((r, _request, { id }) => {
      const plan = r.history.readPlan(id!);
      return { id, ...plan, ...(plan.kind === "dream" ? { overview: new DreamWorkflow(r, neighbors).overview(dreamPlanSchema.parse(plan.value)) } : {}) };
    }))
    .post("/api/write-plans/:id/reject", run((r, _request, { id }) => {
      const plan = r.history.readPlan(id!); if (plan.state !== "proposed") throw new HistoryConflict("This plan cannot be rejected now");
      r.history.markPlan(id!, "rejected"); return { rejected: true };
    }))
    .post("/api/write-plans/:id/apply", run(async (r, request, { id }) => {
      const body = await request.json() as { digest?: string; approved?: boolean; confirmIdentity?: boolean };
      if (body.approved !== true || typeof body.digest !== "string") throw new HistoryConflict("Approve the exact reviewed plan first");
      const plan = r.history.readPlan<{ record?: { table?: string } }>(id!);
      const capability = plan.kind === "row-inverse" ? (plan.value.record?.table === "reminders" ? "reminders.write" : "collections.write") : "okf.write";
      permit(r, capability, plan.operationId);
      if (plan.kind === "dream") { requireDream(); permitDream(r); return new DreamWorkflow(r, neighbors).apply(id!, body.digest, body.confirmIdentity === true); }
      return plan.kind === "okf-inverse" ? r.files.applyInverse(id!, body.digest) : r.rows.applyInverse(id!, body.digest);
    }), { parse: "none" })
    .post("/api/write-history/:id/recover", run(async (r, request, { id }) => {
      const body = await request.json() as { approved?: boolean };
      if (body.approved !== true) throw new HistoryConflict("Inspect and approve recovery first");
      permit(r, "okf.write", id!);
      await r.files.recover(id!); return { operationId: id };
    }), { parse: "none" })
    .get("/api/dream/candidates/:id", run((r, _request, { id }) => new DreamWorkflow(r, neighbors).candidates(decodeURIComponent(id!))))
    .post("/api/dream/proposals", run(async (r, request) => {
      requireDream(); permitDream(r);
      const body = await request.json();
      const input = proposalSchema.parse(body);
      return new DreamWorkflow(r, neighbors).propose(input);
    }), { parse: "none" })
    .post("/api/dream/run", run(r => { requireDream(); permitDream(r); return new DreamWorkflow(r, neighbors).run(); }));
}
import { z } from "zod";
const proposalSchema = z.object({ sourceIds: z.array(z.string()).min(2).max(6), canonicalId: z.string().min(1),
  entityId: z.string().trim().min(1).max(120), title: z.string().trim().min(1).max(120), deprecateDuplicates: z.boolean().default(false) });
