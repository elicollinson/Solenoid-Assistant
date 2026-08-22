# Implementation Plan: Reviewed Agent Execution

**Branch**: `002-reviewed-agent-execution` | **Date**: 2026-08-22 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-reviewed-agent-execution/spec.md`

## Summary

Refactor agent execution into bounded exploration, structured finalization, independent review, deterministic decision, and revision stages. The existing provider abstraction and OpenAI-compatible Chat Completions path remain the integration boundary; reasoning, tools, and structured output become separate capabilities rather than one coupled request. Add first-class deterministic, rubric, adversarial, and guardrail reviewers, expose both simple and detailed execution results, and migrate the existing generator/grader as a compatibility configuration. Screenshot classification adopts adaptive vision: a fast structured pass, validated recovery from a reasoning channel only when ordinary content is blank, and a deliberate analysis/finalization path for ambiguous evidence.

## Technical Context

**Language/Version**: TypeScript 6.0.3 on Bun 1.3+

**Primary Dependencies**: Zod 4.4, OpenAI SDK 6.47, Ollama SDK 0.6, Anthropic SDK 0.111, Elysia 1.4, `p-limit` 7.3, OpenTelemetry/OpenInference/Phoenix

**Storage**: No new durable store. Existing filesystem-backed screenshot state and Phoenix trace export remain unchanged; detailed reviewed results are returned in memory and emitted as bounded trace metadata.

**Testing**: Co-located Bun tests (`bun test`), strict TypeScript check (`bun run typecheck`), scripted/fake provider contract tests, screenshot fixtures, and an opt-in live LM Studio smoke test

**Target Platform**: Bun backend service and cron worker on macOS, using local or remote OpenAI-compatible, Ollama, or Anthropic model endpoints

**Project Type**: Single backend service/library with HTTP and scheduled workflow entry points

**Performance Goals**: At least 90% of clear screenshot fixtures remain on the fast path; at least 90% of uncomplicated first-pass reviewed runs finish within 2x the matching unreviewed baseline; reviewer parallelism remains bounded and configurable

**Constraints**: Preserve public endpoint shapes; keep existing unreviewed agents working; never repeat completed tools merely to repair formatting; validate all accepted values; bound tool, finalization, and review loops independently; do not broaden tool access during review/revision; do not treat raw reasoning as authoritative data

**Scale/Scope**: Personal-assistant service with multiple agent workflows; screenshot batches default to 50 and currently permit up to 500 items, with per-image adaptive escalation and existing batch concurrency controls

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

The repository constitution is an unratified placeholder: it contains no named principles, version, ratification date, or enforceable gates. Therefore there are no constitutional violations and this plan passes the formal gate.

Until a constitution is ratified, the design also applies the repository constraints visible in the code and feature specification:

- Preserve existing HTTP and simple-agent result contracts.
- Keep strict type checking and co-located automated tests.
- Trace each model, tool, review, decision, and terminal phase without persisting unrestricted reasoning.
- Bound all loops and concurrency explicitly.
- Keep reviewer and revision authority within the original workflow's tool permissions.

**Post-design re-check**: Pass. The Phase 1 contracts preserve external endpoint shapes, use bounded state transitions, retain local schema validation, and introduce no storage or authorization expansion.

## Architecture

### Execution flow

```text
request
  -> explore (reasoning + bounded tools, no final schema)
  -> finalize candidate (no tools, reasoning disabled, schema + validation)
  -> review candidate (isolated reviewers, bounded concurrency)
  -> deterministic policy
       accept -> return T / detailed result
       revise -> finalize a new candidate from evidence + normalized findings
       reject -> typed rejection
       exhausted -> typed budget failure with last candidate and reviews
```

Finalization retries operate only on the accumulated transcript/evidence snapshot. They do not re-enter exploration. A revision produces a new candidate version and re-runs all configured reviewers independently.

### Responsibility boundaries

- `ChatProvider` normalizes content, reasoning, tool calls, finish reason, usage; adapters serialize provider-neutral reasoning modes and multimodal attachments.
- Execution primitives own state transitions and budgets, not provider-specific request shapes.
- Reviewers report structured observations; they never accept candidates directly.
- The decision policy computes all scores, thresholds, hard gates, and terminal outcomes deterministically.
- `Agent.run()` remains the simple accepted-value operation; reviewed execution adds `runDetailed()` for internal diagnostics and typed failure context.
- Vision analysis creates explicit evidence before public description/classification. Reasoning-channel text is only a validated recovery source, never implicit cross-stage state.

## Project Structure

### Documentation (this feature)

```text
specs/002-reviewed-agent-execution/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── reviewed-agent.md
│   ├── reviewer.md
│   └── screenshot-classification.md
└── tasks.md                         # Created later by $speckit-tasks
```

### Source Code (repository root)

```text
src/
├── core/
│   ├── execution/
│   │   ├── types.ts                 # Context, budgets, candidate, outcome
│   │   ├── errors.ts                # Typed budget and execution failures
│   │   ├── explore.ts               # Bounded exploration and evidence capture
│   │   └── finalize.ts              # Tool-free structured production/retries
│   ├── review/
│   │   ├── types.ts                 # Reviewer/finding/result contracts
│   │   ├── reviewRunner.ts          # Isolated bounded-concurrency fanout
│   │   ├── policy.ts                # Deterministic accept/revise/reject logic
│   │   ├── reviewedAgent.ts         # State machine and run/runDetailed facade
│   │   ├── rubricGrader.ts          # Model rubric evaluation; local score math
│   │   ├── adversarialReviewer.ts   # Counterexample/evidence-gap review
│   │   ├── deterministicReviewer.ts # Schema and workflow invariant adapter
│   │   └── guardrailReviewer.ts     # Hard-gate review adapter
│   ├── providers.ts                 # Normalized multimodal/reasoning capabilities
│   ├── rawAgent.ts                  # Compatibility facade over primitives
│   └── tracing/
│       └── spans.ts                 # Phase/reviewer attributes and span kinds
├── agents/
│   └── generatorGrader.ts           # Migrated single-grader compatibility facade
├── utils/
│   ├── vision.ts                    # Fast/deliberate/adaptive image execution
│   └── fanout.ts                    # Compatibility wrapper over generic settled fanout
├── workflows/
│   └── screenshotIngestion.ts       # Adaptive vision + reviewed classification opt-in
├── tools/
│   └── photos.ts                    # Existing endpoint result mapping unchanged
└── http/routes/
    └── screenshots.ts               # Existing public contract unchanged

scripts/
└── eval-reviewed-screenshots.ts      # Baseline-versus-reviewed fixture evaluation

# Tests stay co-located with each implementation module using *.test.ts.
```

**Structure Decision**: Extend the existing single TypeScript project. Put reusable execution and review mechanics under `src/core` because both agents and workflows consume them; keep provider-neutral review contracts separate from orchestration to avoid a subclass matrix. Keep HTTP, workflow, and vision adapters at their existing boundaries and migrate them incrementally.

## Implementation Strategy

### Phase A - Provider normalization and immediate vision regression fix

1. Add backward-compatible multimodal attachments to normalized `ChatMessage` and map them in each provider adapter; trace only image metadata, never base64 bytes.
2. Normalize distinct ordinary content, bounded reasoning content, tool calls, finish reason, and usage without breaking current callers.
3. Add provider-neutral reasoning modes (`provider-default`, `enabled`, `disabled`) and serialize only settings supported by each adapter/model configuration.
4. Fix OpenAI-compatible vision extraction: prefer ordinary content; if it is blank, try supported reasoning fields and accept only a fully parsed, schema-valid value.
5. Add request-shape and regression tests for the observed Qwen3.5 response.

### Phase B - Staged execution primitives

1. Extract the tool loop from `Agent.loop()` into an exploration primitive that produces an immutable evidence snapshot and transcript.
2. Add a tool-free finalizer with schema enforcement, local Zod validation, validation-only repair prompts, and an independent retry budget.
3. Add typed budget/execution failures and a state machine that prevents finalization retries from invoking tools.
4. Preserve legacy unstructured behavior and provider fallback parsing through the existing `Agent` facade.
5. Generalize the settled, ordered concurrency pattern in `fanout.ts` for later reviewer use while retaining its current API.

### Phase C - First-class review and revision

1. Define the generic reviewer, finding, result, policy, decision, failure action, and detailed-run contracts.
2. Implement deterministic reviewers, rubric graders, adversarial reviewers, and guardrails behind the same isolated interface.
3. Run reviewers with `p-limit`, `Promise.allSettled`, per-reviewer timeouts, and propagated abort signals; convert provider errors into explicit failed/timed-out review results.
4. Implement deterministic score calculation, duplicate-finding normalization, hard gates, severity rules, threshold rules, required/optional reviewer failure rules, and round-exhaustion behavior.
5. Add revision finalization using the original request, evidence snapshot, current candidate, and normalized findings as delimited user data; do not elevate model feedback to system instructions or grant new tools.

### Phase D - Compatibility migration and adaptive screenshots

1. Re-express `GeneratorGraderAgent` as reviewed execution with one rubric grader while retaining its public pass/revise/stop behavior.
2. Add a typed internal `VisionAnalysis` and fast, deliberate, and adaptive vision modes. Deliberate mode performs image analysis first and structured description finalization second.
3. Make screenshot classification use adaptive vision and screenshot-specific review for identity support, primary/secondary media, categorization evidence, and prompt injection in visible text.
4. Preserve `/screenshots/classify` parameters and response fields. Map evidence-based non-classifiability to the existing `{ classification: "Rejected", name: "Unknown" }` domain result; preserve provider/reviewer infrastructure failures as operational errors.

### Phase E - Observability, evaluation, and rollout

1. Emit an `AGENT` root span; `CHAIN` spans for exploration/finalization/revision/decision; `TOOL`, `EVALUATOR`, and `GUARDRAIL` child spans as appropriate.
2. Record candidate version, review round, reviewer status/verdict/score, finding count/max severity, retries, tool rounds, budget consumption, and termination reason. Bound any retained reasoning excerpt.
3. Build scripted provider tests for every state transition and screenshot fixtures for clear, ambiguous, injected-text, and insufficient-evidence cases.
4. Establish an unreviewed baseline, run seeded-defect and screenshot evaluations with repeated trials, and enable reviewed execution per workflow only after its quality/latency gates pass.

## Verification Gates

- Unit: budget enforcement, state transitions, parsing/validation, score calculation, policy precedence, finding normalization, reviewer isolation, timeout cancellation, and typed errors.
- Contract: `run()` and existing HTTP response shapes remain unchanged; `runDetailed()` and reviewer interfaces match the feature contracts.
- Integration: tool call -> tool result -> tool-free finalization; invalid finalization retry without a second tool call; failed review -> revision -> acceptance; critical guardrail -> rejection.
- Provider: scripted LM Studio-compatible responses covering `content`, `reasoning_content`, `reasoning`, tool calls, malformed calls, and structured output.
- Vision: clear fast path, blank-content reasoning recovery, adaptive escalation, visible-text injection, ambiguous identity, and explicit unknown/rejection.
- Trace: in-memory export verifies span hierarchy, kinds, status, and required attributes for fail -> revise -> pass while retaining existing reasoning truncation guarantees.
- Operational: every run terminates within configured budgets and exposes a traceable termination reason.
- Regression: full `bun test` and `bun run typecheck`; optional live LM Studio Qwen3.5 smoke after deterministic tests pass.

## Rollout and Compatibility

1. Land the response-channel vision fix behind existing behavior because it only recovers fully validated values.
2. Introduce execution/review primitives without changing default `Agent` behavior.
3. Migrate `GeneratorGraderAgent` and compare its existing tests/results.
4. Opt screenshot ingestion into adaptive vision and reviewed classification, retaining endpoint shape and an internal kill switch to legacy execution.
5. Expand per workflow after trace and evaluation thresholds pass. No global default switch is part of this feature.

## Complexity Tracking

No constitutional violations require justification. The additional modules separate independently testable state-machine, provider, review, and policy responsibilities; they do not add a service, database, endpoint, or authorization boundary.
