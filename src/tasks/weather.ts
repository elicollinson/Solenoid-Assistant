import { z } from "zod";
import { defineTask } from "./registry";
import { demoAgentGG } from "../agents/demo";
import { weatherPrompt } from "../prompts";

export const weatherTask = defineTask({
  name: "weather",
  description: "Fetch the weather for a city via the demo GeneratorGrader agent",
  schema: z.object({ city: z.string().min(1) }),
  execute: ({ city }) => demoAgentGG.run(weatherPrompt, { city }),
});
