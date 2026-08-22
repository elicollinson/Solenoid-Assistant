# Phase 0 Research: Reviewed Agent Execution

## Current repository findings

- `src/core/rawAgent.ts` currently owns prompt rendering, tool execution, reasoning flags, structured output, blank retries, tracing, and one aggregate iteration limit.
- `src/agents/generatorGrader.ts` duplicates that control loop for a fixed three-criterion grader. It correctly calculates the average and pass decision in code, but it has no independent review budget, failure policy, reviewer concurrency, or typed exhaustion.
- `src/core/providers.ts` is already the correct transport boundary: `tools`, `think`, and `format` are separate options, native assistant payloads can continue multi-turn conversations, and OpenAI-compatible `reasoning_content` is normalized.
- `src/utils/vision.ts` bypasses `ChatProvider`, duplicating provider selection, authentication, parsing, and reasoning handling. This is why vision did not benefit from the normalization already used by agents.
- `src/utils/fanout.ts` establishes the desired bounded `p-limit` plus `Promise.allSettled` pattern, though its API is currently hard-coded to `Agent.run`.
- `src/core/tracing` already supports `AGENT`, `CHAIN`, `EVALUATOR`, and `GUARDRAIL` spans and caps recorded reasoning at 2,000 characters.
- Screenshot processing currently describes images in parallel and classifies them sequentially. Its internal description schema is erased by casts, limiting safe enrichment with evidence and ambiguity.

## Decision 1: Keep ChatProvider and OpenAI-compatible Chat Completions as the execution boundary

**Decision**: Build reviewed orchestration above `ChatProvider` and continue using `/v1/chat/completions` for LM Studio tools, vision, chat history, and JSON-schema finalization. Do not make `/v1/models` discovery a hard inference health check.

**Rationale**: The application needs client-owned history to isolate reviewers, preserve evidence, retry only finalization, and trace every stage. LM Studio documents Chat Completions support for history, images, custom tools, and JSON-schema output. Its native `/api/v1/chat` offers richer state/reasoning features but does not provide the same arbitrary custom-tool and assistant-history contract. The target server also accepts inference even though `GET /v1/models` logs as unexpected.

**Alternatives considered**:

- `/v1/responses`: promising for reasoning and tools, but adds state semantics and lacks the same documented structured-output guarantee in LM Studio today.
- Native `/api/v1/chat`: useful for model-specific integrations, but unsuitable as the shared custom-tool executor.
- Provider-specific reviewed loops: would duplicate policy and recreate the current vision inconsistency.

Sources: [LM Studio REST endpoint comparison](https://lmstudio.ai/docs/developer/rest), [OpenAI-compatible endpoints](https://lmstudio.ai/docs/developer/openai-compat), [native chat](https://lmstudio.ai/docs/developer/rest/chat).

## Decision 2: Represent reasoning as a provider capability

**Decision**: Replace direct assumptions about `reasoning_effort` with a provider-neutral mode: `provider-default`, `enabled`, or `disabled`. Adapters translate the mode only to settings supported by their endpoint/model. Exploration and reviewers may enable reasoning; strict finalization requests it disabled.

**Rationale**: The live Qwen3.5 server reported that `high` is unsupported and only `on`/`off` are accepted. Reasoning controls and result fields vary across providers and LM Studio versions. Hard-coding `none` or `high` globally is brittle.

**Alternatives considered**:

- Always disable reasoning: reliable serialization but weakens investigation and review.
- Always request maximum reasoning: unsupported by the target model and costly.
- Pass OpenAI reasoning parameters through unchanged: leaks endpoint-specific semantics into workflows.

Sources: [LM Studio native reasoning contract](https://lmstudio.ai/docs/developer/rest/chat), [Qwen3.5 9B metadata](https://lmstudio.ai/models/qwen/qwen3.5-9b), [API changelog](https://lmstudio.ai/docs/developer/api-changelog).

## Decision 3: Normalize response channels but validate any recovery

**Decision**: Provider results expose ordinary content, bounded reasoning content, tool calls, finish reason, and usage separately. Ordinary content is authoritative. A reasoning field may be used only when ordinary content is blank and the recovered value fully parses and validates against the requested schema.

**Rationale**: The observed screenshot calls produced accurate JSON entirely in `reasoning_content` with empty `content`. This is a response-channel compatibility issue, not a vision failure. Validated fallback fixes it without making hidden reasoning a durable interface.

**Alternatives considered**:

- Concatenate content and reasoning: may corrupt JSON and disclose scratch text.
- Prefer reasoning unconditionally: reverses the answer-channel contract.
- Ignore reasoning: preserves the current blank-result regression.

Sources: [reasoning output/statistics](https://lmstudio.ai/docs/developer/rest/chat), [reasoning streaming events](https://lmstudio.ai/docs/developer/rest/streaming-events).

## Decision 4: Add multimodal messages without changing text content to a union

**Decision**: Add optional typed image attachments to `ChatMessage` while keeping `content: string`. Provider adapters map attachments to OpenAI image parts, Ollama images, or Anthropic image blocks. Tracing records attachment count, type, and size only.

**Rationale**: Vision can then reuse provider normalization, structured output, authentication, and tracing without forcing broad churn in callers that currently trim, slice, and serialize string content.

**Alternatives considered**:

- Keep direct SDK calls in `vision.ts`: smaller initial change but retains duplicated behavior.
- Change content to a text/image union: cleaner in isolation but unnecessarily breaks string-oriented callers.

## Decision 5: Separate exploration from strict finalization

**Decision**: Extract an exploration primitive with bounded tools/reasoning and no final schema, followed by a finalizer with no tools, reasoning disabled, a JSON schema, and local Zod validation. A formatting retry reuses the complete evidence snapshot and cannot re-enter the tool loop.

**Rationale**: This matches LM Studio's documented tool flow and directly enforces FR-001 through FR-006. It removes duplicated control loops and makes tool, review, and formatting limits independently testable. The exploration stage exports ordinary draft text and explicit tool evidence, not raw reasoning.

**Alternatives considered**:

- Add more conditionals to `Agent.loop`: preserves fewer files but leaves budgets and transitions coupled.
- Send tools and schema on every turn: makes model intent ambiguous and can suppress useful reasoning.
- Extract arbitrary JSON from one unstructured call: gives up available schema enforcement.

Sources: [LM Studio tool use](https://lmstudio.ai/docs/developer/openai-compat/tools), [structured output](https://lmstudio.ai/docs/developer/openai-compat/structured-output).

## Decision 6: Compose reviewed execution; preserve Agent compatibility

**Decision**: Implement `ReviewedAgent<T>` by composing producer/exploration, finalizer, reviewer runner, and pure policy. Keep existing `Agent.run` overloads and unreviewed defaults. Expose `run(): Promise<T>` for accepted results and `runDetailed(): Promise<ReviewedRunResult<T>>` for diagnostics; non-accepted simple runs throw a typed error carrying the detailed result.

**Rationale**: Composition supports zero, one, or many reviewers without an inheritance matrix and permits scripted-provider testing. Existing workflows and `fanout` depend on the simple `Agent.run` surface.

**Alternatives considered**:

- A reviewer-specific `Agent` subclass for every strategy: duplicates the GeneratorGrader problem.
- Make every Agent reviewed by default: violates incremental adoption.
- Return outcome unions from all existing `run` calls: breaks consumers.

## Decision 7: Make reviews isolated, structured, concurrent, and failure-aware

**Decision**: Every reviewer gets an immutable clone of the same original request, validated candidate, explicit evidence, round/version, and its own rubric/objective. Reviewers never receive peer results or hidden reasoning. Run them through a generic ordered, settled, bounded-concurrency helper with a per-reviewer timeout and propagated abort signal.

Completed assessments and `failed`/`timed_out` outcomes are separate discriminated records. Configuration declares whether a reviewer is required and how its failure is handled. Guardrails default to required/fail-closed; only explicitly optional reviewers may continue after failure.

**Rationale**: Logical independence is a correctness property even when requests queue on one local GPU. Settled results preserve useful findings when one reviewer fails. Revision cannot correct provider outage, so infrastructure failure must not consume candidate-revision rounds by default.

**Alternatives considered**:

- Sequential debate: correlates findings and adds latency.
- `Promise.all`: discards sibling results on one rejection.
- Treat failure as passing: violates fail-safe review.
- Race-only timeout: returns early while the model keeps consuming local resources.

Source: [`p-limit` recipes](https://github.com/sindresorhus/p-limit/blob/main/recipes.md).

## Decision 8: Use a deterministic policy and application-computed scores

**Decision**: Models return criterion observations and scores; code validates exact criterion names/ranges, applies weights, calculates totals, and evaluates thresholds. A pure policy applies this precedence: critical hard gate -> reject; required reviewer failure -> configured fail-closed action; high-severity or below-threshold findings -> revise if a round remains; all gates pass -> accept; no remaining round -> typed exhaustion/rejection according to policy.

**Rationale**: A model reviewer is advisory, not an arbiter. Local calculation makes thresholds auditable and retains the strongest property of the current GeneratorGrader implementation.

**Alternatives considered**:

- LLM arbiter: correlated and able to override hard rules.
- Trust a model-calculated total/pass bit: unverified and nondeterministic.
- Use revision to handle every reviewer error: cannot repair infrastructure failures.

## Decision 9: Normalize reviewer feedback as untrusted data

**Decision**: Deduplicate and delimit findings, then provide them to revision as user/data content under a fixed workflow-owned system prompt. Revision receives the original request, validated candidate, explicit evidence, and normalized findings but no new tools.

**Rationale**: The current GeneratorGrader elevates model feedback to a system message. Adversarial responses or visible screenshot text can echo injection content; model-produced feedback must never gain system priority.

**Alternatives considered**:

- Keep feedback as a system message: stronger steering but unsafe authority escalation.
- Pass raw reviewer transcripts: noisy, correlated, and difficult to validate.

## Decision 10: Use adaptive staged vision and a richer internal analysis

**Decision**: Move vision through the shared provider and support:

- `fast`: reasoning disabled, schema requested, local validation, then validated reasoning-channel recovery only if content is blank;
- `deliberate`: image analysis without a final schema into explicit ordinary observations, followed by text-only structured finalization;
- `adaptive`: fast first, deliberate only on blank/invalid, ambiguous, or insufficiently supported results.

Introduce an internal `VisionAnalysis` with observations, prominent text, primary/secondary content, candidate identities/evidence, ambiguities, and classifiability. Map it back to current public fields.

**Rationale**: Qwen3.5 accurately understood both images. Adaptive staging repairs channel placement, preserves latency for clear images, and supplies explicit evidence for adversarial identity review.

**Alternatives considered**:

- Always deliberate: doubles work on clear images.
- Always single pass: keeps ambiguity and unsupported-identity risk.
- Add evidence fields to the HTTP response: violates the compatibility boundary.

Sources: [OpenAI-compatible image input](https://lmstudio.ai/docs/developer/openai-compat), [Qwen3.5 capabilities](https://lmstudio.ai/models/qwen3.5).

## Decision 11: Migrate screenshot classification first and distinguish domain rejection from execution failure

**Decision**: Configure screenshot classification with a deterministic schema/domain reviewer, rubric grader, adversarial identity/media reviewer, and required visible-text injection guardrail. Evidence-based non-classifiability maps to the existing `{ "classification": "Rejected", "name": "Unknown" }`. Provider, tool, timeout, and required-review infrastructure errors remain operational errors.

**Rationale**: This addresses the active failure and the highest-confidence risk while preserving `/screenshots/classify`. Conflating outages with a valid domain rejection would hide reliability problems.

**Alternatives considered**:

- Return detailed review metadata from the endpoint: breaks its contract.
- Map every failure to `Rejected`: hides operational faults.

## Decision 12: Extend current OpenInference tracing and evaluate comparatively

**Decision**: Use one `AGENT` root; `CHAIN` spans for explore/finalize/revise/decision; existing `TOOL` spans; `EVALUATOR` spans for graders/adversaries/deterministic checks; and `GUARDRAIL` spans only for actual safety/policy gates. Record round, candidate version, reviewer kind/status/verdict/score, findings, budget counts, and termination reason. Keep raw reasoning only as the existing bounded LLM-span diagnostic and omit image bytes.

Add pure policy/budget tests, scripted provider scenarios, reviewer concurrency/cancellation tests, in-memory trace assertions, seeded-defect fixtures, and labeled screenshot fixtures. Compare baseline and reviewed modes for blank rate, defect recall, confident-wrong rate, correct retention, rejection, escalation, latency, calls, and tokens. Keep live LM Studio smoke tests opt-in.

**Rationale**: Existing span primitives already support the needed hierarchy. Comparative fixtures are required to decide per-workflow rollout without turning variable live inference into the deterministic unit suite.

**Alternatives considered**:

- One aggregate agent span: obscures failure and latency attribution.
- Persist full reasoning: conflicts with the bounded-diagnostic requirement.
- Live-only tests: slow and nondeterministic.

Sources: [OpenInference specification](https://arize-ai.github.io/openinference/spec/), [semantic conventions](https://arize-ai.github.io/openinference/spec/semantic_conventions.html), [Phoenix evaluator traces](https://arize.com/docs/phoenix/evaluation/llm-evals/evaluator-traces).
