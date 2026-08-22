import { Agent } from "../core/rawAgent";
import { createChatProvider } from "../core/providerFactory";
import { loadRuntimeConfig } from "../core/config";
import { log } from "../core/logger";
import { createImessageIntakeAgent } from "../agents/imessageIntake";
import { okfManagerAgent } from "../agents/okfManager";
import {
  imessageIntakePrompt,
  imessageIntakeSchema,
  memoryGraderPrompt,
  memoryGraderSchema,
  memoryGraderSystemPrompt,
  okfManagerResultSchema,
  type ImessageIntakeResult,
  type OkfManagerResult,
} from "../prompts";
import { fanout, rejected } from "../utils/fanout";

const MEMORY_PASS_THRESHOLD = 7;
const runtimeConfig = loadRuntimeConfig();

const memoryGraderAgent = new Agent({
  name: "memory-grader",
  client: createChatProvider(runtimeConfig),
  model: runtimeConfig.model,
  systemPrompt: memoryGraderSystemPrompt,
});

export interface MessageExtractionParams {
  start?: Date;
  end?: Date;
}

export interface MessageExtractionResult extends Omit<ImessageIntakeResult, "memoryContext"> {
  memoryContext: string[];
  okfUpdate: OkfManagerResult | "none";
}

export interface MessageExtractionDependencies {
  grader?: Agent;
  okfManager?: Agent;
}

export async function extractMessages(
  params: MessageExtractionParams = {},
  dependencies: MessageExtractionDependencies = {},
): Promise<MessageExtractionResult> {
  const intakeAgent = createImessageIntakeAgent(
    params.start || params.end ? { start: params.start, end: params.end } : undefined,
    runtimeConfig,
  );
  const extracted = await intakeAgent.run(
    imessageIntakePrompt({
      start: params.start?.toISOString(),
      end: params.end?.toISOString(),
    }),
    imessageIntakeSchema,
  );

  const graded = await fanout(
    extracted.memoryContext.map((output) => ({ output })),
    dependencies.grader ?? memoryGraderAgent,
    memoryGraderPrompt,
    memoryGraderSchema,
    8,
  );
  const failures = rejected(graded);
  if (failures.length > 0) {
    log.warn(
      `messageExtraction: ${failures.length}/${graded.length} memory grades failed; ` +
        `withholding those memories. First error: ${failures[0]?.message}`,
    );
  }

  const memoryContext = extracted.memoryContext.filter((_, index) => {
    const result = graded[index];
    if (result?.status !== "fulfilled") return false;
    const { memoryRelevance, memoryActionability } = result.value;
    return (memoryRelevance + memoryActionability) / 2 > MEMORY_PASS_THRESHOLD;
  });

  const okfUpdate =
    memoryContext.length === 0
      ? "none"
      : await (dependencies.okfManager ?? okfManagerAgent).run(
          `Update the okf with these memories:\n${memoryContext
            .map((memory) => `- ${memory}`)
            .join("\n")}`,
          okfManagerResultSchema,
        );

  return { ...extracted, memoryContext, okfUpdate };
}
