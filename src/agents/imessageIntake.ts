import { GeneratorGrader } from "./generatorGrader";
import { createReadImessagesTool, type ReadWindow } from "../tools/imessage";
import { getTimeTool } from "../tools/time";
import { Ollama } from "ollama";

/**
 * Build the intake agent, optionally with its read_imessages tool hard-bound
 * to a time window (see createReadImessagesTool: with a window, the tool has
 * no time parameters at all, so the range is enforced rather than requested).
 * Constructed per request when a window is involved — the bounds live in the
 * tool's closure, so a shared singleton would leak one request's window into
 * the next.
 */
export function createImessageIntakeAgent(window?: ReadWindow): GeneratorGrader {
  return new GeneratorGrader({
    client: new Ollama({
      host: process.env.OLLAMA_API_URL || "https://ollama.com",
      headers: { Authorization: `Bearer ${process.env.OLLAMA_API_KEY || ""}` },
    }),
    model: process.env.MODEL || "glm-5.2",
    tools: [createReadImessagesTool(window), getTimeTool],
  });
}
