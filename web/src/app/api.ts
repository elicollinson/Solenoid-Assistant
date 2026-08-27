import { useEffect, useState } from "react";
import type { CalendarDetailPayload, CalendarPayload } from "../../../src/shared/calendar";
import type { HomePayload } from "../../../src/shared/home";
import type { KnowledgeDetailPayload, KnowledgePayload } from "../../../src/shared/knowledge";
import type { RecommendationDetailPayload, RecommendationsPayload } from "../../../src/shared/recommendations";
import type { ReminderDetailPayload, RemindersPayload } from "../../../src/shared/reminders";
import type { Surface } from "../../../src/shared/surface";
import type { WorkflowDetailPayload, WorkflowRunAccepted, WorkflowsPayload } from "../../../src/shared/workflows";

export type * from "../../../src/shared/calendar";
export type * from "../../../src/shared/home";
export type * from "../../../src/shared/knowledge";
export type * from "../../../src/shared/recommendations";
export type * from "../../../src/shared/reminders";
export type * from "../../../src/shared/surface";
export type * from "../../../src/shared/workflows";

export type Load<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; message: string };

async function getJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return (await response.json()) as T;
}

/**
 * Everything the home surface draws, in one read.
 *
 * No refetch-on-focus, no polling: nothing writes yet, so a second read would
 * only redraw the same rows. When actions start firing this is where the
 * invalidation goes.
 */
export function useHome(surface: Surface = "desktop"): Load<HomePayload> {
  return useJson<HomePayload>(on("/api/home", surface));
}

/**
 * Which frame is asking, as a query the server can read.
 *
 * The phone's copy is written separately from the desktop's, so the surface has
 * to travel with the request rather than be decided in the browser. It is also
 * part of the cache key by being part of the path: turning a tablet sideways
 * past the breakpoint re-reads rather than redraws the other frame's sentences.
 */
function on(path: string, surface: Surface): string {
  return surface === "desktop" ? path : `${path}?surface=${surface}`;
}

/**
 * One read per surface, the same as the home screen. `useJson` is the shared
 * body: fetch on mount, abort on unmount, re-fetch when the path changes — or
 * when `nonce` does, which is how a caller says "ask again" without changing
 * what it is asking. Starting a run bumps it once; a run in flight bumps it on
 * a timer, because the server has no way to tell the browser the step moved.
 *
 * The answer is stored with the path it answers. An effect runs after the
 * render that scheduled it, so the first render at a new path still holds the
 * old path's data — and a surface that switches from a list to a detail in that
 * same render would be handed the list payload and read fields off it that are
 * not there. Comparing the two is what makes the change take effect
 * immediately rather than one render late.
 */
function useJson<T>(path: string | null, nonce = 0): Load<T> {
  const [state, setState] = useState<{ path: string | null; load: Load<T> }>({ path, load: { status: "loading" } });

  useEffect(() => {
    if (path == null) return;
    const controller = new AbortController();
    // A re-read at the same path keeps what is on screen rather than blanking
    // it: a workflow polled every two seconds while it runs would otherwise
    // flash "Reading" between every answer.
    setState((current) => (current.path === path ? current : { path, load: { status: "loading" } }));
    getJson<T>(path, controller.signal)
      .then((data) => setState({ path, load: { status: "ready", data } }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ path, load: { status: "error", message: error instanceof Error ? error.message : String(error) } });
      });
    return () => controller.abort();
  }, [path, nonce]);

  return state.path === path ? state.load : { status: "loading" };
}

/**
 * The path for one member of a collection, or null when there is no member to
 * ask about.
 *
 * Null rather than an empty id on purpose. `/api/workflows/` is not an empty
 * member of the collection — the router reads the trailing slash off and
 * answers with the collection itself, 200 and all. A detail hook that asked
 * that question would be handed the list, call it ready, and the first render
 * after a row is clicked would read detail fields off a list payload.
 */
export function detailPath(base: string, id: string | null | undefined): string | null {
  return id ? `${base}/${encodeURIComponent(id)}` : null;
}

/** The workflow table. Bump `nonce` to re-read it. */
export function useWorkflows(surface: Surface = "desktop", nonce = 0): Load<WorkflowsPayload> {
  return useJson<WorkflowsPayload>(on("/api/workflows", surface), nonce);
}

/**
 * One workflow, with every execution it has kept. Null asks for nothing:
 * `/api/workflows/` is the collection, not an empty member of it, so a detail
 * hook with no id would quietly be handed the table.
 */
export function useWorkflow(slug: string | null, surface: Surface = "desktop", nonce = 0): Load<WorkflowDetailPayload> {
  const path = detailPath("/api/workflows", slug);
  return useJson<WorkflowDetailPayload>(path && on(path, surface), nonce);
}

/** Everything I'm holding for you. */
export function useReminders(): Load<RemindersPayload> {
  return useJson<RemindersPayload>("/api/reminders");
}

/** One reminder, with the artifacts behind it. Null asks for nothing. */
export function useReminder(id: string | null): Load<ReminderDetailPayload> {
  return useJson<ReminderDetailPayload>(detailPath("/api/reminders", id));
}

/** Every standing suggestion I hold, shelved by whether you have answered it. */
export function useRecommendations(): Load<RecommendationsPayload> {
  return useJson<RecommendationsPayload>("/api/recommendations");
}

/** One suggestion, with what I formed it from. Null asks for nothing. */
export function useRecommendation(id: string | null): Load<RecommendationDetailPayload> {
  return useJson<RecommendationDetailPayload>(detailPath("/api/recommendations", id));
}

/** The week, in one read. Switching between week and day, or from one day to
 *  another, is a filter over what is already here rather than another fetch. */
export function useCalendar(surface: Surface = "desktop"): Load<CalendarPayload> {
  return useJson<CalendarPayload>(on("/api/calendar", surface));
}

/** One thing on the canvas. Null asks for nothing. */
export function useCalendarItem(id: string | null): Load<CalendarDetailPayload> {
  return useJson<CalendarDetailPayload>(detailPath("/api/calendar", id));
}

/** Everything I've written down. */
export function useKnowledge(surface: Surface = "desktop"): Load<KnowledgePayload> {
  return useJson<KnowledgePayload>(on("/api/knowledge", surface));
}

/** One memory, with the facts in it and what links to it. Null asks for nothing. */
export function useKnowledgeObject(id: string | null): Load<KnowledgeDetailPayload> {
  return useJson<KnowledgeDetailPayload>(detailPath("/api/knowledge", id));
}

/**
 * Every write in the app, and the one shape they share.
 *
 * A refusal is thrown carrying what the server said rather than a status code,
 * because every one of them is something to put in front of you: a required
 * field left empty, a workflow you paused, a run that ended while you were
 * reaching for the button. The server writes those sentences; this only
 * carries them.
 */
async function send<T>(path: string, method: "POST" | "PUT", body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const answer = (await response.json().catch(() => null)) as { error?: string } | T | null;
  if (!response.ok) {
    const said = answer && typeof answer === "object" && "error" in answer && answer.error
      ? answer.error
      : `the server answered ${response.status}`;
    throw new Error(said);
  }
  return answer as T;
}

/**
 * Start a run, and answer with the run that is now under way.
 *
 * It returns as soon as the run row exists rather than when the work finishes —
 * a screenshot sweep can take twenty minutes — so the caller's job afterwards
 * is to re-read the workflow, not to await a result that was never coming down
 * this connection.
 */
export function runWorkflow(slug: string, args: Record<string, unknown>): Promise<WorkflowRunAccepted> {
  return send<WorkflowRunAccepted>(`/api/workflows/${encodeURIComponent(slug)}/run`, "POST", { args });
}

/**
 * Stop the run this workflow has going.
 *
 * What it can promise is narrow and the server's log line says so: the run is
 * written down as stopped now, and whatever the work returns afterwards is
 * dropped rather than recorded.
 */
export function stopWorkflow(slug: string): Promise<{ runId: string }> {
  return send(`/api/workflows/${encodeURIComponent(slug)}/stop`, "POST");
}

/** Pause or resume, on the record rather than in this tab. */
export function pauseWorkflow(slug: string, paused: boolean): Promise<{ paused: boolean }> {
  return send(`/api/workflows/${encodeURIComponent(slug)}/pause`, "POST", { paused });
}

/** Replace the standing instruction. Empty text retires it without a successor. */
export function saveInstructions(slug: string, text: string): Promise<{ text: string | null }> {
  return send(`/api/workflows/${encodeURIComponent(slug)}/instructions`, "PUT", { text });
}
