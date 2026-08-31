// The agent that reads a conversation and says what is in it.
//
// It holds NO tools, and that is the design rather than an omission: the
// messages are fetched by ../workflows/messageExtraction.ts, screened, and put
// into the prompt, so by the time this agent runs there is nothing left for it
// to go and get. An agent that could fetch its own would be an agent holding a
// stranger's text and a way to ask for more of it.
//
// There used to be a second factory here, `createImessageIntakeAgent`, which
// held `read_imessages` bound to a time window. Nothing called it — the window
// enforcement it existed for lives in the tool itself
// (`createReadImessagesTool`, ../tools/imessage.ts) and in the `imessage` tool
// group built on it, both of which are still there and still tested. A factory
// with no callers is not a spare part; it is a claim about how this service
// works that stopped being true without anybody noticing.
import { Agent } from "../core/rawAgent";
import { createGraderReviewer } from "./graderReviewer";
import { createModelRoutes } from "../core/providerFactory";
import { loadRuntimeConfig, type RuntimeConfig } from "../core/config";

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
