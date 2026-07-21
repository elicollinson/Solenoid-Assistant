import { GeneratorGrader } from "./generatorGrader";
import { readImessagesTool } from "../tools/imessage";
import { getTimeTool } from "../tools/time";
import { Ollama } from "ollama";

export const imessageIntakeAgent = new GeneratorGrader({
  client: new Ollama({
    host: process.env.OLLAMA_API_URL || "https://ollama.com",
    headers: { Authorization: `Bearer ${process.env.OLLAMA_API_KEY || ""}` },
  }),
  model: process.env.MODEL || "glm-5.2",
  tools: [readImessagesTool, getTimeTool],
});
