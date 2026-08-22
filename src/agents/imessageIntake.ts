import { GeneratorGrader } from "./generatorGrader";
import { createReadImessagesTool, type ReadWindow } from "../tools/imessage";
import { getTimeTool } from "../tools/time";
import { createOllamaClient } from "../core/ollama";
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
): GeneratorGrader {
  return new GeneratorGrader({
    name: "imessage-intake",
    client: createOllamaClient({}, config),
    model: config.model,
    tools: [createReadImessagesTool(window), getTimeTool],
  });
}
