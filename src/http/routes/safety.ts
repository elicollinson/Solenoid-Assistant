import { Elysia, t } from "elysia";
import { classifySafety } from "../../workflows/safetyClassification";

interface SafetyContext {
  body: { input: string; maxLength: number };
  set: { status?: number | string };
}

const safetyHandler = async ({ body, set }: SafetyContext) => {
  try {
    return await classifySafety(body.input, body.maxLength);
  } catch (error) {
    set.status = 502;
    return { error: error instanceof Error ? error.message : "Agent call failed" };
  }
};

const safetyContract = {
  detail: { summary: "Classify input text for safety concerns" },
  body: t.Object({
    input: t.String({ minLength: 1, description: "Input text to classify" }),
    maxLength: t.Number({
      minimum: 2,
      description: "Maximum number of words per random-length chunk",
    }),
  }),
  response: {
    200: t.Object({
      flagged: t.Boolean(),
      concern: t.String(),
      score: t.Number(),
    }),
    502: t.Object({ error: t.String() }),
  },
};

export const safetyRoutes = new Elysia({ name: "routes.safety" })
  .post("/safety-classifier", safetyHandler, safetyContract)
  .post("/safetyClassifier", safetyHandler, {
    ...safetyContract,
    detail: {
      ...safetyContract.detail,
      deprecated: true,
      summary: "Legacy alias for /safety-classifier",
    },
  });
