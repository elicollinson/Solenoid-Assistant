// The agent that reads a conversation and says what is in it.
//
// It holds NO tools, and that is the design rather than an omission: the
// messages are fetched by ../workflows/messageExtraction.ts, screened, and put
// into the prompt, so by the time this agent runs there is nothing left for it
// to go and get. An agent that could fetch its own would be an agent holding a
// stranger's text and a way to ask for more of it.
import { loadRuntimeConfig, type RuntimeConfig } from "../core/config";
import { AssistantAgent } from "../core/engine";
import { createModelRoutes } from "../core/providerFactory";
import { createSecurityScreener } from "../safety/modelArmor";
import { createGraderReviewer } from "./graderReviewer";

/** Intake agent for an already-retrieved, single-conversation prompt. */
export function createImessageConversationAgent(
  config: RuntimeConfig = loadRuntimeConfig(),
): AssistantAgent {
  const routes = createModelRoutes(config);
  const primary = routes[0];
  return new AssistantAgent({
    name: "imessage-conversation-intake",
    routes,
    screen: createSecurityScreener(config),
    reviewers: [
      createGraderReviewer({
        client: primary.client,
        model: primary.model,
      }),
    ],
  });
}
