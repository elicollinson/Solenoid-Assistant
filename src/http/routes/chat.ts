// The Chat surface's routes: list conversations, read one, subscribe to its
// persistent event stream, enqueue turns, cancel in-flight work, answer gates,
// and connect Gemini Live voice.
//
// `:id` accepts the literal "latest", which is what a client with nowhere
// particular to be asks for — the phone opening Chat cold. It starts one if
// there is none, so the screen always has something to draw.
//
// Everything is injected — the database, agent, model, and coordinator — so
// route tests stay 100% deterministic and offline without live LLM calls.
import { Elysia, t } from "elysia";
import { and, eq } from "drizzle-orm";
import { AlreadySettledError, ApprovalNotFoundError } from "@elicollinson/solenoid-security";
import * as schema from "../../db/schema";
import { isSurface, type Surface } from "../../shared/surface";
import { getDb, type Db } from "../../db";
import { log } from "../../core/logger";
import { loadRuntimeConfig } from "../../core/config";
import { createChatAgent, type ChatAgent } from "../../agents/chat";
import { loadChat, loadConversations } from "../../db/queries/chat";
import { DrizzleSkillStore } from "../../db/skills";
import {
  NoSuchDecisionError,
  blankConversation,
  latestConversation,
} from "../../db/mutations/chat";
import { NotWaitingError, answerApproval, runChatTurn } from "../../chat/session";
import { getDefaultCoordinator, type SessionCoordinator } from "../../chat/coordinator";
import type { ChatEvent } from "../../chat/turn";
import { GeminiLiveSession } from "../../chat/geminiLive";

/**
 * Legacy agent, built lazily only when a caller explicitly uses the legacy path.
 */
function lazyAgent(resolveDb: () => Db): () => ChatAgent {
  let agent: ChatAgent | undefined;
  return () => (agent ??= createChatAgent({ db: resolveDb() }));
}

/**
 * The model that answers typed chat: the first route in the chain. Read per
 * request, like the agent's own config, and null rather than a throw when the
 * config does not parse, so the header goes blank instead of the transcript.
 */
function configuredChatModel(): string | null {
  try {
    return loadRuntimeConfig().model;
  } catch {
    return null;
  }
}

/** Whether an id names a chat at all — a 404 rather than an empty transcript. */
function exists(db: Db, id: string): boolean {
  return Boolean(
    db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(and(eq(schema.conversations.id, id), eq(schema.conversations.channel, "agent_chat")))
      .get(),
  );
}

/** One SSE frame. Named so a client can switch on the name before parsing. */
function frame(event: ChatEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function createChatRoutes(
  resolveDb: () => Db = getDb,
  resolveAgent?: () => ChatAgent,
  resolveModel: () => string | null = configuredChatModel,
  resolveCoordinator?: () => SessionCoordinator,
) {
  const useCoordinator = Boolean(resolveCoordinator) || !resolveAgent;
  const coordinatorFor = resolveCoordinator ?? (() => getDefaultCoordinator(resolveDb));
  const agentFor = resolveAgent ?? lazyAgent(resolveDb);

  const asked = (query: { surface?: string }): Surface =>
    isSurface(query.surface) ? query.surface : "desktop";
  const surfaceQuery = t.Object({
    surface: t.Optional(t.Union([t.Literal("desktop"), t.Literal("phone")])),
  });

  return new Elysia({ name: "routes.chat" })
    .get(
      "/api/chat",
      ({ query }) => loadConversations(resolveDb(), new Date(), asked(query)),
      {
        query: surfaceQuery,
        detail: { summary: "Every conversation with the agent, newest first" },
      },
    )
    .post(
      "/api/chat",
      ({ set }) => {
        set.status = 201;
        return { conversationId: blankConversation(resolveDb()) };
      },
      {
        detail: { summary: "Start a conversation. It names itself from the first thing you say." },
        response: { 201: t.Object({ conversationId: t.String() }) },
      },
    )
    .get(
      "/api/chat/skills",
      () => ({
        skills: new DrizzleSkillStore(resolveDb()).listSlashCommands(),
      }),
      {
        detail: { summary: "Enabled reusable skills invocable as /<slug> commands in chat" },
      },
    )
    .get(
      "/api/chat/:id",
      ({ params, query, set }) => {
        const db = resolveDb();
        const id = params.id === "latest" ? latestConversation(db) : params.id;
        const chat = loadChat(db, id, new Date(), asked(query));
        if (!chat.turns.length && !exists(db, id)) {
          set.status = 404;
          return { error: `No conversation with id ${id}` };
        }
        return { ...chat, model: chat.model ?? resolveModel() };
      },
      {
        params: t.Object({ id: t.String() }),
        query: surfaceQuery,
        detail: { summary: "One conversation, and what in it is still waiting on you" },
      },
    )
    .get(
      "/api/chat/:id/stream",
      ({ params, request, set }) => {
        const db = resolveDb();
        const conversationId = params.id === "latest" ? latestConversation(db) : params.id;
        if (!exists(db, conversationId)) {
          set.status = 404;
          return { error: `No conversation with id ${conversationId}` };
        }

        const coordinator = coordinatorFor();
        const encoder = new TextEncoder();
        let unsubscribe: (() => void) | undefined;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        let closed = false;

        const cleanup = () => {
          if (closed) return;
          closed = true;
          if (heartbeat) {
            clearInterval(heartbeat);
            heartbeat = undefined;
          }
          unsubscribe?.();
          unsubscribe = undefined;
        };

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const push = (event: ChatEvent) => {
              if (closed) return;
              try {
                controller.enqueue(encoder.encode(frame(event)));
              } catch {
                cleanup();
              }
            };

            unsubscribe = coordinator.subscribe(conversationId, push);

            heartbeat = setInterval(() => {
              if (closed) return;
              try {
                controller.enqueue(encoder.encode(": keepalive\n\n"));
              } catch {
                cleanup();
              }
            }, 25_000);
            heartbeat.unref?.();

            const onAbort = () => {
              cleanup();
              try {
                controller.close();
              } catch {
                // Already closed.
              }
            };
            if (request.signal.aborted) {
              onAbort();
            } else {
              request.signal.addEventListener("abort", onAbort, { once: true });
            }
          },
          cancel() {
            cleanup();
          },
        });

        return new Response(stream, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          },
        });
      },
      {
        params: t.Object({ id: t.String() }),
        detail: {
          summary:
            "Subscribe to the persistent SSE stream for a conversation. Immediately pushes a " +
            "snapshot frame and fans out live turns, approvals, and async subagent completions.",
        },
      },
    )
    .post(
      "/api/chat/:id/messages",
      async ({ params, body, set }) => {
        const db = resolveDb();
        const conversationId = params.id === "latest" ? latestConversation(db) : params.id;
        if (!exists(db, conversationId)) {
          set.status = 404;
          return { error: `No conversation with id ${conversationId}` };
        }

        if (useCoordinator) {
          const { turnId } = await coordinatorFor().send(conversationId, body.text);
          set.status = 202;
          return { turnId };
        }

        // Legacy fallback when an explicit `resolveAgent` was injected without a coordinator.
        const events = runChatTurn(db, agentFor(), conversationId, body.text);
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder();
            try {
              for await (const event of events) {
                controller.enqueue(encoder.encode(frame(event)));
              }
            } catch (error) {
              log.warn("chat stream ended early", {
                conversationId,
                error: error instanceof Error ? error.message : String(error),
              });
            } finally {
              controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          },
        });
      },
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({ text: t.String({ minLength: 1 }) }),
        detail: {
          summary:
            "Enqueue a message into the conversation's serialized session queue (202 Accepted).",
        },
      },
    )
    .post(
      "/api/chat/:id/cancel",
      async ({ params, set }) => {
        const db = resolveDb();
        const conversationId = params.id === "latest" ? latestConversation(db) : params.id;
        if (!exists(db, conversationId)) {
          set.status = 404;
          return { error: `No conversation with id ${conversationId}` };
        }
        const cancelled = await coordinatorFor().cancel(conversationId);
        return { cancelled };
      },
      {
        params: t.Object({ id: t.String() }),
        detail: { summary: "Cancel the currently running turn for a conversation, if any" },
      },
    )
    .post(
      "/api/chat/decisions",
      async ({ body, set }) => {
        try {
          if (useCoordinator) {
            return await coordinatorFor().answerDecision(body.actionId);
          }
          return answerApproval(resolveDb(), body.actionId);
        } catch (error) {
          if (
            error instanceof NoSuchDecisionError ||
            error instanceof ApprovalNotFoundError ||
            error instanceof AlreadySettledError
          ) {
            set.status = 409;
            return { error: error.message };
          }
          if (error instanceof NotWaitingError) {
            set.status = 410;
            return { error: error.message };
          }
          throw error;
        }
      },
      {
        body: t.Object({
          actionId: t.String({
            minLength: 1,
            description:
              "The id of the button that was pressed. Never a boolean: a client that " +
              "could post its own verdict could record the wrong one against your name.",
          }),
        }),
        detail: { summary: "Answer an approval the agent is waiting on" },
        response: {
          200: t.Object({
            decisionId: t.String(),
            outcome: t.Union([
              t.Literal("approved"),
              t.Literal("declined"),
              t.Literal("expired"),
            ]),
            resumed: t.Optional(t.Boolean()),
            deferred: t.Optional(t.Boolean()),
          }),
          409: t.Object({ error: t.String() }),
          410: t.Object({ error: t.String() }),
        },
      },
    )
    .ws("/api/chat/:id/voice", {
      params: t.Object({ id: t.String() }),
      async open(ws) {
        const db = resolveDb();
        const conversationId =
          ws.data.params.id === "latest" ? latestConversation(db) : ws.data.params.id;
        if (!exists(db, conversationId)) {
          ws.send(
            JSON.stringify({ type: "error", message: `No conversation with id ${conversationId}` }),
          );
          ws.close();
          return;
        }

        const liveSession = new GeminiLiveSession({
          db,
          conversationId,
          ...(useCoordinator ? { coordinator: coordinatorFor() } : {}),
          onEvent: (event) => {
            try {
              ws.send(JSON.stringify(event));
            } catch (err) {
              log.warn("Failed to send event to voice client WS", {
                conversationId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          },
        });

        (ws.data as unknown as { liveSession?: GeminiLiveSession }).liveSession = liveSession;

        try {
          await liveSession.start();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error("Voice session startup failed", { conversationId, error: message });
          ws.send(JSON.stringify({ type: "error", message }));
          ws.close();
        }
      },
      async message(ws, msg: unknown) {
        const liveSession = (ws.data as unknown as { liveSession?: GeminiLiveSession }).liveSession;
        if (!liveSession || liveSession.isClosed) return;

        try {
          const payload = typeof msg === "string" ? JSON.parse(msg) : msg;
          if (payload && typeof payload === "object") {
            const data = payload as {
              type?: string;
              data?: string;
              text?: string;
              enabled?: boolean;
            };
            if (data.type === "audio" && typeof data.data === "string") {
              liveSession.sendAudio(data.data);
            } else if (data.type === "text" && typeof data.text === "string") {
              liveSession.sendText(data.text);
            } else if (data.type === "set_extended_thinking" && typeof data.enabled === "boolean") {
              await liveSession.setExtendedThinking(data.enabled);
            } else if (data.type === "stop") {
              liveSession.close();
              ws.close();
            }
          }
        } catch (err) {
          log.warn("Invalid message from voice client WS", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
      close(ws) {
        const liveSession = (ws.data as unknown as { liveSession?: GeminiLiveSession }).liveSession;
        liveSession?.close();
      },
    });
}
