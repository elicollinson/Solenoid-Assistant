import { Elysia, t } from "elysia";
import { weatherAgent } from "../../agents/demo";
import { createContentCardSourcingAgent } from "../../agents/contentCardSourcing";
import type { AgentResource } from "../../agents/resource";
import { log } from "../../core/logger";
import { contentCardSchema, weatherPrompt, type ContentCard } from "../../prompts";

export const agentRoutes = new Elysia({ name: "routes.agents" })
  .post(
    "/agent",
    async ({ body, set }) => {
      const city = body.city.trim();
      if (!city) {
        set.status = 400;
        return { error: 'Missing "city" field' };
      }
      try {
        const response = await weatherAgent.run(weatherPrompt, { city });
        return { city, response };
      } catch (error) {
        set.status = 502;
        return { error: error instanceof Error ? error.message : "Agent call failed" };
      }
    },
    {
      detail: { summary: "Get weather for a city via the demo agent" },
      body: t.Object({
        city: t.String({ minLength: 1, description: "City to get weather for" }),
      }),
      response: {
        200: t.Object({ city: t.String(), response: t.String() }),
        400: t.Object({ error: t.String() }),
        502: t.Object({ error: t.String() }),
      },
    },
  )
  .post(
    "/content-card",
    async ({ body, set }) => {
      const query = body.query.trim();
      if (!query) {
        set.status = 400;
        return { error: 'Missing "query" field' };
      }

      let resource: AgentResource | undefined;
      try {
        resource = await createContentCardSourcingAgent();
        const card = (await resource.agent.run(query, contentCardSchema)) as ContentCard;
        return { query, ...card };
      } catch (error) {
        log.error("POST /content-card failed", {
          query,
          error: error instanceof Error ? error.message : String(error),
        });
        set.status = 502;
        return {
          error: error instanceof Error ? error.message : "Content card sourcing failed",
        };
      } finally {
        await resource?.close();
      }
    },
    {
      detail: {
        summary:
          "Source a content card for a media item using live web search via Tavily MCP.",
      },
      body: t.Object({
        query: t.String({
          minLength: 1,
          description: "The name of the media item to look up.",
        }),
      }),
      response: {
        200: t.Object({
          query: t.String(),
          name: t.String(),
          type: t.Union([
            t.Literal("Game"),
            t.Literal("Musician"),
            t.Literal("Movie"),
            t.Literal("TV Show"),
            t.Literal("Song"),
            t.Literal("Album"),
            t.Literal("Book"),
          ]),
          description: t.String(),
          coverImageUrl: t.String(),
          url: t.String(),
        }),
        400: t.Object({ error: t.String() }),
        502: t.Object({ error: t.String() }),
      },
    },
  );
