
import { z } from "zod";
import { defineTool } from "../core/tools";
import { log } from "../core/logger";

export const weatherTool = defineTool({
  name: "get_weather",
  description: "Get current weather for a city",
  schema: z.object({ city: z.string() }),
  execute: ({ city }) => {
    // `log` lines inside a tool land on its TOOL span as timestamped events
    // (visible in the Phoenix span's Events tab) as well as on the console.
    log.info(`looking up weather for ${city}`);
    return { city, tempF: 74, conditions: "partly cloudy" };
  },
});
export const calculateTool = defineTool({
  name: "calculate",
  description: "Evaluate a math expression",
  schema: z.object({ expression: z.string() }),
  execute: ({ expression }) => String(Function(`"use strict"; return (${expression})`)()),
});
