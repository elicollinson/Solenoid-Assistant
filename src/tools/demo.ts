
import { z } from "zod";
import { defineTool } from "../utils/tools";

export const weatherTool = defineTool({
  name: "get_weather",
  description: "Get current weather for a city",
  schema: z.object({ city: z.string() }),
  execute: ({ city }) => ({ city, tempF: 74, conditions: "partly cloudy" }),
});
export const calculateTool = defineTool({
  name: "calculate",
  description: "Evaluate a math expression",
  schema: z.object({ expression: z.string() }),
  execute: ({ expression }) => String(Function(`"use strict"; return (${expression})`)()),
});
