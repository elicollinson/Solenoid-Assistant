import { Elysia, t } from "elysia";
import { openapi } from "@elysiajs/openapi";
import { demoAgent } from "./agents/demo";

const PORT = Number(process.env.PORT ?? 3000);

const app = new Elysia()
  .use(
    openapi({
      documentation: {
        info: {
          title: "Manual Personal Assistant API",
          version: "0.1.0",
        },
      },
    }),
  )
  .get("/health", () => ({ status: "ok" as const }), {
    detail: { summary: "Health check" },
    response: t.Object({ status: t.Literal("ok") }),
  })
  .post(
    "/agent",
    async ({ body, set }) => {
      const city = body.city.trim();
      if (!city) {
        set.status = 400;
        return { error: 'Missing "city" field' };
      }

      try {
        const response = await demoAgent.run(`What's the weather in ${city}?`);
        return { city, response };
      } catch (err) {
        set.status = 502;
        return {
          error: err instanceof Error ? err.message : "Agent call failed",
        };
      }
    },
    {
      detail: { summary: "Get weather for a city via the demo agent" },
      body: t.Object({
        city: t.String({ minLength: 1, description: "City to get weather for" }),
      }),
      response: {
        200: t.Object({
          city: t.String(),
          response: t.String(),
        }),
        400: t.Object({ error: t.String() }),
        502: t.Object({ error: t.String() }),
      },
    },
  )
  .listen(PORT);

console.log(`Service listening on http://localhost:${app.server?.port}`);
console.log(`API docs at http://localhost:${app.server?.port}/openapi`);
