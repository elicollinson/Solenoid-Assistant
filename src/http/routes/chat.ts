// The Chat surface's routes: list conversations, read one, say something into
// it, and answer a gate.
//
// An ordinary collection, except for one route that is unlike anything else in
// this directory. A chat turn is not request/response — it is a run that talks
// while it works and then STOPS to ask you something — so
// `POST /api/chat/:id/messages` answers with an event stream and holds it open,
// possibly for minutes, while a person decides.
//
// Which means the answer to that question cannot arrive on the same connection:
// it comes in on `POST /api/chat/decisions`, a second request, and finds the
// suspended run through the map in ../../chat/session.ts. The two are halves of
// one thing and neither reads correctly alone. `decisions` is not under a
// conversation because a decision knows its own conversation and the client
// answering one has an action id and nothing else.
//
// `:id` accepts the literal "latest", which is what a client with nowhere
// particular to be asks for — the phone opening Chat cold. It starts one if
// there is none, so the screen always has something to draw.
//
// Everything is injected — the database and the agent both — because the
// alternative is a test that needs a model.
import { Elysia, t } from "elysia";
import { and, eq } from "drizzle-orm";
import * as schema from "../../db/schema";
import { isSurface, type Surface } from "../../shared/surface";
import { getDb, type Db } from "../../db";
import { log } from "../../core/logger";
import { createChatAgent, type ChatAgent } from "../../agents/chat";
import { loadChat, loadConversations } from "../../db/queries/chat";
import {
  NoSuchDecisionError,
  latestConversation,
  startConversation,
} from "../../db/mutations/chat";
import { NotWaitingError, answerApproval, runChatTurn } from "../../chat/session";
import type { ChatEvent } from "../../chat/turn";

/**
 * The agent, built once and only if somebody talks to it.
 *
 * Lazy because building it reads the runtime config and opens provider clients,
 * and importing this module must not do either — ../../index.ts is imported by
 * every route test in the repository.
 */
function lazyAgent(resolveDb: () => Db): () => ChatAgent {
  let agent: ChatAgent | undefined;
  return () => (agent ??= createChatAgent({ db: resolveDb() }));
}

/** Whether an id names a chat at all — a 404 rather than an empty transcript. */
function exists(db: Db, id: string): boolean {
  return Boolean(
    db.select({ id: schema.conversations.id })
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
) {
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
        return { conversationId: startConversation(resolveDb()) };
      },
      {
        detail: { summary: "Start a conversation. It names itself from the first thing you say." },
        response: { 201: t.Object({ conversationId: t.String() }) },
      },
    )
    .get(
      "/api/chat/:id",
      ({ params, query, set }) => {
        const db = resolveDb();
        // "latest" rather than an id is what a client with nowhere particular
        // to be asks for — the phone opening Chat cold, a deep link with
        // nothing after it. It starts one if there is none, so the screen
        // always has something to draw.
        const id = params.id === "latest" ? latestConversation(db) : params.id;
        const chat = loadChat(db, id, new Date(), asked(query));
        if (!chat.turns.length && !exists(db, id)) {
          set.status = 404;
          return { error: `No conversation with id ${id}` };
        }
        return chat;
      },
      {
        params: t.Object({ id: t.String() }),
        query: surfaceQuery,
        detail: { summary: "One conversation, and what in it is still waiting on you" },
      },
    )
    .post(
      "/api/chat/:id/messages",
      ({ params, body, set }) => {
        const db = resolveDb();
        const conversationId = params.id === "latest" ? latestConversation(db) : params.id;
        if (!exists(db, conversationId)) {
          set.status = 404;
          return { error: `No conversation with id ${conversationId}` };
        }
        const events = runChatTurn(db, agentFor(), conversationId, body.text);

        // Built by hand rather than returned as a generator: this needs to be a
        // 200 with the stream headers the moment it is called, before the model
        // has said anything. A client that waited for the first token to learn
        // whether it was talking to an event stream would show nothing at all
        // for however long the first tool call takes.
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder();
            try {
              for await (const event of events) {
                controller.enqueue(encoder.encode(frame(event)));
              }
            } catch (error) {
              // runChatTurn turns a failed run into an `error` event, so
              // reaching here means the stream itself broke — the client went
              // away mid-turn, most often. Not worth an error frame nobody can
              // receive; worth a line saying the turn was orphaned.
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
            // Nginx and friends buffer an event stream into uselessness.
            "x-accel-buffering": "no",
          },
        });
      },
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({ text: t.String({ minLength: 1 }) }),
        detail: {
          summary:
            "Say something to the agent. Answers with an event stream: tool calls as they " +
            "happen, an approval when one is needed, and the reply at the end.",
        },
      },
    )
    .post(
      "/api/chat/decisions",
      ({ body, set }) => {
        try {
          return answerApproval(resolveDb(), body.actionId);
        } catch (error) {
          if (error instanceof NoSuchDecisionError) {
            // Already answered, in another tab or a moment ago. Not a failure
            // on this end: re-read and the transcript says what was chosen.
            set.status = 409;
            return { error: error.message };
          }
          if (error instanceof NotWaitingError) {
            // The settlement is written; only the run is gone. Said apart from
            // the 409 because the screen's honest words differ — one is "you
            // already answered that", the other is "I am no longer holding it".
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
          }),
          409: t.Object({ error: t.String() }),
          410: t.Object({ error: t.String() }),
        },
      },
    );
}
