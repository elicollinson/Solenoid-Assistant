# Internal Contract: Reviewed Agent Execution

This is a TypeScript library contract, not a new HTTP API. Names may be refined during implementation, but the semantics and compatibility requirements are normative.

## Configuration

```ts
type ReasoningMode = "provider-default" | "enabled" | "disabled";

interface ExecutionBudgets {
  maxToolRounds: number;
  maxReviewRounds: number;
  maxFinalizationRetries: number;
  reviewerConcurrency: number;
  reviewerTimeoutMs: number;
}

interface ReviewedAgentOptions<Input, Output> {
  id: string;
  outputSchema: z.ZodType<Output>;
  tools?: readonly Tool[];
  budgets?: Partial<ExecutionBudgets>;
  reviewers?: readonly ReviewerConfig<Output>[];
  policy?: ReviewPolicy;
  renderRequest(input: Input): string | readonly ChatMessage[];
}
```

Defaults are 5 tool rounds, 2 review rounds, 2 finalization retries after the initial attempt, reviewer concurrency 4, and a finite configured timeout. Workflow configuration may reduce concurrency for a local GPU.

## Operations

```ts
interface ReviewedAgent<Input, Output> {
  run(input: Input, options?: RunOptions): Promise<Output>;
  runDetailed(
    input: Input,
    options?: RunOptions,
  ): Promise<ReviewedRunResult<Output>>;
}
```

- `run` returns only a schema-valid, policy-accepted `Output`.
- `run` throws `ReviewedRunError` for rejection, exhaustion, cancellation, or failure. The error carries the corresponding serializable detailed result.
- `runDetailed` returns an accepted/rejected/exhausted/failed discriminated union and does not erase completed candidate/review history.
- Existing `Agent.run(prompt, input?, schema?)` overloads remain compatible and do not become reviewed by default.

## Staged execution contract

### Exploration

- May use only tools configured on the original workflow.
- May use provider reasoning according to configured capabilities.
- Does not request the final output schema.
- One assistant turn containing one or more tool calls consumes one tool round.
- Tool names and arguments are validated before execution.
- Produces an immutable `EvidenceSnapshot` containing ordinary draft text, explicit tool results, observations, and required continuation history.
- Raw reasoning is excluded from the evidence snapshot.

### Initial finalization

- Receives the original request and exploration evidence.
- Sends no tool definitions and rejects any attempted tool use.
- Requests reasoning disabled where the provider supports it.
- Requests the output JSON schema where supported.
- Parses and locally validates with the caller's Zod schema.
- On invalid output, retries only finalization using validation feedback and the same evidence snapshot.

### Review

- Starts only after a candidate fully validates.
- Runs all configured reviewers independently against the same immutable candidate/evidence snapshot.
- Uses bounded concurrency, preserves configured reviewer order in results, and retains sibling results after one reviewer fails.
- Zero configured reviewers causes immediate acceptance after validation without consuming a review round.

### Revision

- Occurs only after deterministic policy returns `revise` and another review round exists.
- Receives the original request, current validated candidate, explicit evidence, and normalized/delimited review findings as untrusted user data.
- Does not receive new tool permissions and does not promote reviewer output to a system message.
- Produces a new locally validated candidate with version incremented by one.

## Result union

```ts
interface RunUsage {
  toolRounds: number;
  reviewRounds: number;
  finalizationAttempts: number;
  finalizationRetries: number;
}

interface RunHistory<T> {
  runId: string;
  candidates: readonly CandidateVersion<T>[];
  rounds: readonly ReviewRound[];
  usage: RunUsage;
  startedAt: string;
  completedAt: string;
}

type ReviewedRunResult<T> =
  | (RunHistory<T> & {
      status: "accepted";
      terminationReason: "accepted" | "validated_without_reviewers";
      value: T;
      acceptedCandidate: CandidateVersion<T>;
    })
  | (RunHistory<T> & {
      status: "rejected";
      terminationReason: string;
      lastCandidate?: CandidateVersion<T>;
      reasonCodes: readonly string[];
    })
  | (RunHistory<T> & {
      status: "exhausted";
      terminationReason: string;
      limit: "tool_rounds" | "review_rounds" | "finalization_retries";
      lastCandidate?: CandidateVersion<T>;
    })
  | (RunHistory<T> & {
      status: "failed";
      terminationReason: string;
      phase: ExecutionPhase;
      lastCandidate?: CandidateVersion<T>;
      error: { name: string; message: string };
    });
```

The public diagnostic record must not include base64 images, secrets, unrestricted tool payloads, or raw model reasoning.

## Errors

```ts
class ReviewedRunError<T> extends Error {
  readonly result: Exclude<ReviewedRunResult<T>, { status: "accepted" }>;
}

class ToolRoundExhaustedError<T> extends ReviewedRunError<T> {}
class FinalizationExhaustedError<T> extends ReviewedRunError<T> {}
class ReviewExhaustedError<T> extends ReviewedRunError<T> {}
```

Errors are typed by failure category and retain the last candidate and completed review records where available. New reviewed APIs never return a sentinel string such as `Stopped: hit max iterations.` as if it were a candidate.

## Provider result contract

The normalized provider layer preserves these channels separately:

```ts
interface NormalizedAssistantResult {
  content: string;
  reasoning?: string;
  toolCalls?: readonly ToolCall[];
  finishReason?: string;
  usage?: TokenUsage;
  nativePayload?: unknown;
}
```

- Ordinary `content` is authoritative.
- `reasoning` remains bounded diagnostics.
- A workflow may recover structured data from `reasoning` only when `content` is blank and the recovered data fully validates.
- Native payload is continuation-only provider state and is not a reviewer/revision interface.

## Backward compatibility

- Unmigrated `Agent` workflows retain their current request/result behavior.
- Existing provider fallback parsing remains available when native schema enforcement is unavailable, but application validation remains mandatory.
- `GeneratorGraderAgent` becomes a wrapper around reviewed execution configured with one rubric grader. Its existing public constructor/run behavior and legacy stopping behavior remain until a separately approved breaking migration.
- Adoption is per workflow; there is no global enablement switch in this feature.
