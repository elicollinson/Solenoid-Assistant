import { useState } from "react";

interface Row { id: string; tool: string; execution: string; response: string; capability: string; createdAt: number; inverseOf?: string }
interface Plan { id: string; kind: string; digest: string; value: unknown; overview?: string }
const panel = { padding: 20, border: "1px solid var(--line, #bbb)", borderRadius: 8, marginBottom: 20 };

/** A protected review surface. The access key stays in component memory, never
 * the URL, browser storage, telemetry or a model prompt.
 */
export function WriteHistoryView() {
  const [token, setToken] = useState("");
  const [rows, setRows] = useState<Row[]>([]), [plans, setPlans] = useState<Plan[]>([]);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null), [plan, setPlan] = useState<Plan | null>(null);
  const [message, setMessage] = useState("Enter the history access key configured for this app."), [busy, setBusy] = useState(false);
  const [identity, setIdentity] = useState(false), [sourceIds, setSourceIds] = useState("");
  const [canonicalId, setCanonicalId] = useState(""), [entityId, setEntityId] = useState(""), [title, setTitle] = useState("");
  const [duplicates, setDuplicates] = useState(false);
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(path, { method: body === undefined ? "GET" : "POST", cache: "no-store",
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) {
      let message = response.status === 401 ? "Access key was not accepted." : "The operation could not complete.";
      try { message = (await response.json()).error ?? message; } catch { /* Plain authorization response. */ }
      throw new Error(message);
    }
    return response.json() as Promise<T>;
  }
  async function action(fn: () => Promise<void>) {
    setBusy(true); setMessage("");
    try { await fn(); } catch (e) { setMessage(e instanceof Error ? e.message : "Operation failed"); }
    finally { setBusy(false); }
  }
  async function load() {
    const result = await request<{ rows: Row[]; captureEnabled: boolean }>("/api/write-history"); setRows(result.rows);
    setPlans((await request<{ plans: Plan[] }>("/api/write-plans")).plans);
    if (!result.captureEnabled) setMessage("Write history is available. Captured changes and undo need the history encryption key configured on the server.");
  }
  async function openPlan(id: string) { setPlan(await request<Plan>(`/api/write-plans/${id}`)); setIdentity(false); }
  return <main style={{ maxWidth: 1100, margin: "auto", padding: 24, color: "var(--text-2)", font: "var(--text-body)" }}>
    <a href="/">← Back to Solenoid</a>
    <h1>Write history &amp; memory reflection</h1>
    <p>Inspect changes, review memory proposals, and reverse supported local changes. Sent notifications and unclassified remote effects cannot be undone here.</p>
    <form style={panel} onSubmit={e => { e.preventDefault(); void action(load); }}>
      <label>History access key <input type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} /></label>{" "}
      <button disabled={busy || !token}>Open history</button>
    </form>
    <p role="status" aria-live="polite">{message || (busy ? "Working…" : "")}</p>
    <section style={panel}>
      <h2>Recent writes</h2>
      {!rows.length ? <p>No history loaded.</p> : <ul>{rows.map(row => <li key={row.id} style={{ marginBottom: 12 }}>
        <button disabled={busy} onClick={() => void action(async () => setDetail(await request(`/api/write-history/${row.id}`)))}>{row.tool.replaceAll("_", " ")}</button>
        {" · "}{row.execution.replaceAll("_", " ")}{row.response !== "delivered" ? ` · response ${row.response.replaceAll("_", " ")}` : ""}
        {" · "}<time>{new Date(row.createdAt).toLocaleString()}</time>{" · "}{row.capability === "conditional_local_inverse" ? "Captured local change" : "History only"}
      </li>)}</ul>}
      {detail && <div><h3>Recorded change</h3>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 450, overflow: "auto" }}>{JSON.stringify(detail, null, 2)}</pre>
        {detail.capability === "conditional_local_inverse" && detail.execution === "committed" && <button disabled={busy} onClick={() => void action(async () => {
          const result = await request<{ id: string }>(`/api/write-history/${detail.id}/reversal-plans`, {}); await openPlan(result.id);
        })}>{detail.inverseOf ? "Review redo" : "Review undo"}</button>}
        {detail.execution === "partial" && <button disabled={busy} onClick={() => void action(async () => {
          await request(`/api/write-history/${detail.id}/recover`, { approved: true }); setMessage("Saved plan recovered. Refresh history to inspect the result."); await load();
        })}>Finish this saved interrupted change</button>}
      </div>}
    </section>
    <section style={panel}>
      <h2>Memory proposals</h2>
      <p>Reflection is disabled until explicitly configured. Preparing a proposal keeps the original memories unchanged.</p>
      <button disabled={busy} onClick={() => void action(async () => {
        const result = await request<{ proposals: unknown[]; uncertain: number; unavailable: number }>("/api/dream/run", {});
        await load(); setMessage(`${result.proposals.length} proposals; ${result.uncertain} identity candidates need selection; ${result.unavailable} seeds lacked ready semantic neighbors.`);
      })}>Examine related memories</button>
      <ul>{plans.map(p => <li key={p.id}><button disabled={busy} onClick={() => void action(() => openPlan(p.id))}>Review {p.kind.replaceAll("-", " ")}</button></li>)}</ul>
      <details><summary>Prepare an overview from selected memories</summary>
        <form onSubmit={e => { e.preventDefault(); void action(async () => {
          const result = await request<{ id: string }>("/api/dream/proposals", { sourceIds: sourceIds.split(/[,\n]/).map(s => s.trim()).filter(Boolean), canonicalId, entityId, title, deprecateDuplicates: duplicates });
          await openPlan(result.id); await load();
        }); }}>
          <p><label>Source memory IDs (two to six, separated by commas)<br /><textarea required value={sourceIds} onChange={e => setSourceIds(e.target.value)} style={{ width: "100%" }} placeholder="memories/example-one, memories/example-two" /></label></p>
          <p><label>Overview path <input required value={canonicalId} onChange={e => setCanonicalId(e.target.value)} placeholder="people/dad" /></label></p>
          <p><label>Scoped entity key <input required value={entityId} onChange={e => setEntityId(e.target.value)} placeholder="user:father" /></label></p>
          <p><label>Overview title <input required value={title} onChange={e => setTitle(e.target.value)} /></label></p>
          <p><label><input type="checkbox" checked={duplicates} onChange={e => setDuplicates(e.target.checked)} /> Propose deprecating exact duplicates of the same source account, keeping their text</label></p>
          <button disabled={busy}>Prepare for review</button>
        </form>
      </details>
    </section>
    {plan && <section style={panel} aria-label="Review exact changes">
      <h2>Review {plan.kind.replaceAll("-", " ")}</h2>
      <p>Later edits are checked again before applying. If they conflict, the current content is preserved.</p>
      {plan.overview && <pre style={{ whiteSpace: "pre-wrap" }}>{plan.overview}</pre>}
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 500, overflow: "auto" }}>{JSON.stringify(plan.value, null, 2)}</pre>
      {plan.kind === "dream" && <p><label><input type="checkbox" checked={identity} onChange={e => setIdentity(e.target.checked)} /> I reviewed the sources and confirm these accounts concern the same entity. This approves organization, not factual verification.</label></p>}
      <button disabled={busy || (plan.kind === "dream" && !identity)} onClick={() => void action(async () => {
        await request(`/api/write-plans/${plan.id}/apply`, { digest: plan.digest, approved: true, confirmIdentity: identity });
        setPlan(null); await load(); setMessage("Changes applied. Their captured history is available above.");
      })}>Apply these reviewed changes</button>{" "}
      <button disabled={busy} onClick={() => void action(async () => { await request(`/api/write-plans/${plan.id}/reject`, {}); setPlan(null); await load(); })}>Keep things as they are</button>
    </section>}
  </main>;
}
