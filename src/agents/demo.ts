
import { Agent } from "../utils/raw_agent";
import { weatherTool, calculateTool } from "../tools/demo";
import { Ollama } from "ollama";

export const demoAgent = new Agent({
  client: new Ollama({
    host: process.env.OLLAMA_API_URL || "https://ollama.com",
    headers: { Authorization: `Bearer ${process.env.OLLAMA_API_KEY || ""}` },
  }),
  model: process.env.MODEL || "glm-5.2",
  tools: [
    weatherTool,
    calculateTool
  ],
});


