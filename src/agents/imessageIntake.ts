import { Agent } from "../core/rawAgent";
import { createGraderReviewer } from "./graderReviewer";
import { createReadImessagesTool, type ReadWindow } from "../tools/imessage";
import { getTimeTool } from "../tools/time";
import { createModelRoutes } from "../core/providerFactory";
import { loadRuntimeConfig, type RuntimeConfig } from "../core/config";

/**
 * Build the intake agent, optionally with its read_imessages tool hard-bound
 * to a time window (see createReadImessagesTool: with a window, the tool has
 * no time parameters at all, so the range is enforced rather than requested).
 * Constructed per request when a window is involved — the bounds live in the
 * tool's closure, so a shared singleton would leak one request's window into
 * the next.
 */
export function createImessageIntakeAgent(
  window?: ReadWindow,
  config: RuntimeConfig = loadRuntimeConfig(),
): Agent {
  const routes = createModelRoutes(config);
  const primary = routes[0];
  return new Agent({
    name: "imessage-intake",
    routes,
    tools: [createReadImessagesTool(window), getTimeTool],
    reviewers: [createGraderReviewer({
      client: primary.client,
      model: primary.model,
    })],
  });
}

/** Intake agent for an already-retrieved, single-conversation prompt. */
export function createImessageConversationAgent(
  config: RuntimeConfig = loadRuntimeConfig(),
): Agent {
  const routes = createModelRoutes(config);
  const primary = routes[0];
  return new Agent({
    name: "imessage-conversation-intake",
    routes,
    reviewers: [createGraderReviewer({
      client: primary.client,
      model: primary.model,
    })],
  });
}
