
import { join } from "node:path";
import { Agent } from "../core/rawAgent";
import { createOkfTools } from "../tools/okf";
import {okfManagerPrompt} from "../prompts"
import { Ollama } from "ollama";

// Anchored to this module, not the process cwd: a bare "../../okf" resolves
// against wherever the server was launched from (with `bun start` at the repo
// root that meant ~/Documents/okf), so the store's location silently depended
// on the launch directory.
const {all} = createOkfTools({
  root: join(import.meta.dir, "../../okf"), // <repo>/okf
  actor: "okfManagerAgent",
})

export const okfManagerAgent = new Agent({
  client: new Ollama({
    host: process.env.OLLAMA_API_URL || "https://ollama.com",
    headers: { Authorization: `Bearer ${process.env.OLLAMA_API_KEY || ""}` },
  }),
  systemPrompt: okfManagerPrompt,
  model: process.env.MODEL || "glm-5.2",
  tools: [...all],
});
