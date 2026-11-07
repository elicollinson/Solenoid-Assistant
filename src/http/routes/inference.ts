// The inference hold, for scripts on other machines (see inferenceHold.ts).
//
// Machine-facing like /api/sources, and guarded the same way: a bearer token
// of at least 32 characters in INFERENCE_HOLD_TOKEN, and every route refuses
// while it is unset.
import { Elysia } from "elysia";
import { z } from "zod";
import { getDb, type Db } from "../../db";
import { bearerAuthorized } from "../bearer";
import {
  holdInference,
  holdRequestSchema,
  inferenceStatus,
  releaseInference,
  releaseRequestSchema,
} from "../../workflows/inferenceHold";

export function createInferenceRoutes(resolveDb: () => Db = getDb) {
  const guarded =
    (handler: (request: Request, db: Db) => Promise<unknown> | unknown) =>
    async ({ request }: { request: Request }) => {
      if (!bearerAuthorized(request, process.env.INFERENCE_HOLD_TOKEN))
        return new Response("Unauthorized", { status: 401 });
      try {
        return await handler(request, resolveDb());
      } catch (error) {
        if (error instanceof z.ZodError || error instanceof SyntaxError)
          return new Response(`Invalid hold request: ${error instanceof z.ZodError ? z.prettifyError(error) : "body is not JSON"}`, { status: 400 });
        throw error;
      }
    };
  const body = async (request: Request) => {
    const text = await request.text();
    return text ? JSON.parse(text) : {};
  };
  return new Elysia({ name: "routes.inference" })
    .get("/api/inference/hold", guarded((_, db) => inferenceStatus(db)), {
      detail: { summary: "Whether inference is on hold, by whom, and how much work is queued" },
    })
    .post(
      "/api/inference/hold",
      guarded(async (request, db) => holdInference(db, holdRequestSchema.parse(await body(request)))),
      { parse: "none", detail: { summary: "Hold (or renew a hold on) scheduled inference" } },
    )
    .post(
      "/api/inference/release",
      guarded(async (request, db) => releaseInference(db, releaseRequestSchema.parse(await body(request)).holder)),
      { parse: "none", detail: { summary: "Release a hold; queued work runs in order once none remain" } },
    );
}
