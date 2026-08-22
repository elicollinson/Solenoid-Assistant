---

description: "Dependency-ordered implementation tasks for reviewed agent execution"
---

# Tasks: Reviewed Agent Execution

**Input**: Design documents from `/specs/002-reviewed-agent-execution/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`

**Tests**: The feature specification defines independent tests and measurable automated acceptance criteria, so each user-story phase includes tests before implementation.

**Organization**: Tasks are grouped by user story so each increment can be implemented and verified independently at its checkpoint.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel after its phase prerequisites because it touches different files and does not depend on another incomplete task in the same parallel group.
- **[Story]**: Maps the task to one of the five user stories in `spec.md`.
- Every task names the exact file or directory it changes.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish module entry points and deterministic provider-test infrastructure in the existing Bun/TypeScript project.

- [ ] T001 Create initial execution and review barrel modules in `src/core/execution/index.ts` and `src/core/review/index.ts`
- [ ] T002 [P] Implement a reusable queued-response/call-capture `ChatProvider` test harness with abort support in `src/core/testing/scriptedProvider.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Normalize provider control/results and generalize settled concurrency before user-story orchestration is built.

**CRITICAL**: Complete this phase before starting any user story.

- [ ] T003 [P] Add failing contract tests for provider-neutral reasoning modes, separate ordinary/reasoning channels, finish reason, usage, and propagated abort signals in `src/core/providers.test.ts`
- [ ] T004 Implement provider-neutral `ReasoningMode`, normalized result metadata, and abort-signal translation for OpenAI-compatible, Ollama, and Anthropic adapters in `src/core/providers.ts`
- [ ] T005 [P] Add failing tests for ordered `p-limit` plus `Promise.allSettled` behavior, concurrency caps, and partial failures in `src/utils/fanout.test.ts`
- [ ] T006 Generalize settled bounded concurrency while preserving the existing Agent fanout API in `src/utils/fanout.ts`

**Checkpoint**: Provider calls expose stable stage controls/results and a shared ordered concurrency primitive is available.

---

## Phase 3: User Story 1 - Reason Before Returning Structured Results (Priority: P1) MVP

**Goal**: Let an agent reason and use bounded tools before a separate tool-free, schema-valid finalization stage, with formatting retries that never repeat completed tools.

**Independent Test**: Run a scripted request requiring a tool, return an invalid structured draft once, then a valid result. Verify the tool executes exactly once, finalization calls contain no tools with reasoning disabled, the returned value validates, and an unstructured Agent retains conversational behavior.

### Tests for User Story 1

- [ ] T007 [P] [US1] Add failing tests for budget defaults/validation, monotonic counters, and typed tool/finalization exhaustion records in `src/core/execution/types.test.ts` and `src/core/execution/errors.test.ts`
- [ ] T008 [P] [US1] Add failing tests for multi-call tool rounds, tool name/argument validation, evidence ordering, and raw-reasoning exclusion in `src/core/execution/explore.test.ts`
- [ ] T009 [P] [US1] Add failing tests for tool-free structured finalization, local Zod validation, repair prompts, and finalization-only retry exhaustion in `src/core/execution/finalize.test.ts`
- [ ] T010 [P] [US1] Add a failing Agent integration test for tool evidence followed by invalid/valid formatting and unchanged unstructured behavior in `src/core/rawAgent.test.ts`

### Implementation for User Story 1

- [ ] T011 [US1] Implement `ExecutionBudget`, `ExecutionContext`, `EvidenceSnapshot`, `ToolEvidence`, `CandidateVersion`, counters, defaults, and validation in `src/core/execution/types.ts`
- [ ] T012 [US1] Implement serializable `ReviewedRunError`, tool-round exhaustion, and finalization exhaustion classes in `src/core/execution/errors.ts`
- [ ] T013 [US1] Extract bounded exploration with provider reasoning, validated tools, provider-native continuation, and immutable evidence capture in `src/core/execution/explore.ts`
- [ ] T014 [US1] Implement tool-free structured finalization with reasoning disabled, schema enforcement/fallback parsing, Zod validation, and formatting-only repair retries in `src/core/execution/finalize.ts`
- [ ] T015 [US1] Route structured `Agent.run` through exploration/finalization while preserving existing unstructured overloads and legacy behavior in `src/core/rawAgent.ts`
- [ ] T016 [US1] Export the completed staged-execution contracts and errors from `src/core/execution/index.ts`

**Checkpoint**: User Story 1 is independently usable as an unreviewed staged agent and satisfies FR-001 through FR-006 plus the structured portion of FR-035.

---

## Phase 4: User Story 2 - Review, Challenge, and Revise Candidates (Priority: P1)

**Goal**: Make deterministic checks, rubric graders, adversarial reviewers, and guardrails independently configurable, then combine them with a deterministic accept/revise/reject policy and bounded revisions.

**Independent Test**: Seed candidate v1 with an unsupported claim. Verify isolated grader/adversary results request revision, v2 uses explicit evidence and normalized feedback, all locally calculated thresholds pass, and a separate critical-guardrail case rejects despite high grader scores.

### Tests for User Story 2

- [ ] T017 [P] [US2] Add failing contract tests for reviewer/configuration discriminated unions, required/onFailure validation, immutable context, and detailed run result shapes in `src/core/review/types.test.ts`
- [ ] T018 [P] [US2] Add a failing policy truth-table test for score thresholds, severity precedence, critical guardrails, required/optional failures, zero reviewers, deduplication, and round exhaustion in `src/core/review/policy.test.ts`
- [ ] T019 [P] [US2] Add failing deferred-reviewer tests for bounded concurrency, configured-order results, input isolation, sibling completion, timeout, and observed abort signals in `src/core/review/reviewRunner.test.ts`
- [ ] T020 [P] [US2] Add failing tests for exact rubric criterion validation, range/weight math, ignored model totals, adversarial findings, deterministic invariants, and guardrail results in `src/core/review/modelReviewers.test.ts`
- [ ] T021 [P] [US2] Add a failing scripted integration test for reject/revise/pass, no-reviewer acceptance, required-reviewer failure, critical rejection, and typed exhaustion in `src/core/review/reviewedAgent.test.ts`

### Implementation for User Story 2

- [ ] T022 [US2] Implement reviewer kinds, findings, criterion scores, completed/failed/timed-out outcomes, configs, rounds, decisions, and `ReviewedRunResult<T>` in `src/core/review/types.ts`
- [ ] T023 [US2] Implement rubric math, finding normalization/deduplication, failure actions, hard-gate precedence, and pure accept/revise/reject decisions in `src/core/review/policy.ts`
- [ ] T024 [US2] Implement isolated ordered reviewer fanout with bounded concurrency, settled outcomes, per-reviewer timeout, and cancellation propagation in `src/core/review/reviewRunner.ts`
- [ ] T025 [US2] Implement the shared staged structured model-review helper with fixed workflow system instructions and delimited untrusted candidate/evidence data in `src/core/review/modelReviewer.ts`
- [ ] T026 [P] [US2] Implement code-only shape and workflow-invariant review adapters in `src/core/review/deterministicReviewer.ts`
- [ ] T027 [P] [US2] Implement configurable rubric grading that returns criterion evidence while calculating totals/verdicts locally in `src/core/review/rubricGrader.ts`
- [ ] T028 [P] [US2] Implement adversarial review for assumptions, counterexamples, alternate conclusions, contradictions, and evidence gaps in `src/core/review/adversarialReviewer.ts`
- [ ] T029 [P] [US2] Implement required/fail-closed guardrail adapters with critical-finding semantics in `src/core/review/guardrailReviewer.ts`
- [ ] T030 [US2] Compose exploration, finalization, reviewer fanout, deterministic decisions, delimited-feedback revision, candidate versioning, budgets, `run`, and `runDetailed` in `src/core/review/reviewedAgent.ts`
- [ ] T031 [US2] Export reviewed execution, reviewer implementations, policy, and result/error contracts from `src/core/review/index.ts`

**Checkpoint**: User Story 2 can run unreviewed, grader-only, adversarial-only, guardrail-only, or combined configurations and always terminates with an auditable typed outcome.

---

## Phase 5: User Story 3 - Reliably Classify Screenshots (Priority: P2)

**Goal**: Recover valid LM Studio vision output from supported response channels, escalate ambiguous screenshots through deliberate analysis, review identity evidence, and reject unsupported classifications without changing endpoint shapes.

**Independent Test**: Process clear, ambiguous, no-media, secondary-ad, visible-injection, and blank-content/valid-reasoning fixtures. Verify the clear image stays fast, ambiguity escalates once, injected text is untrusted, valid reasoning recovery succeeds, and insufficient evidence yields the existing rejected/unknown domain value.

### Tests and fixtures for User Story 3

- [ ] T032 [P] [US3] Add failing adapter tests for optional image attachments mapped to OpenAI content parts, Ollama images, and Anthropic base64 blocks without altering text-only messages in `src/core/providers.test.ts`
- [ ] T033 [P] [US3] Add failing vision regression tests for ordinary-content preference, schema-valid `reasoning_content`/`reasoning` fallback, malformed fallback rejection, and no image bytes in errors in `src/utils/vision.test.ts`
- [ ] T034 [P] [US3] Add failing fast/deliberate/adaptive tests for escalation triggers, one deliberate pass, text-only finalization, and classifiability signals in `src/utils/visionModes.test.ts`
- [ ] T035 [P] [US3] Add failing generic-schema and rich `VisionAnalysis` mapping tests for screenshot description batches in `src/tools/photos.test.ts`
- [ ] T036 [P] [US3] Add failing classification tests for identity evidence, primary-versus-secondary content, injection guardrails, rejected/unknown mapping, and operational-error separation in `src/workflows/screenshotIngestion.test.ts` and `src/http/app.test.ts`
- [ ] T037 [P] [US3] Add labeled clear/ambiguous/insufficient/injection/secondary-content fixture manifests and deterministic response data in `src/data/reviewed-screenshots/manifest.json` and `src/data/reviewed-screenshots/responses.json`

### Implementation for User Story 3

- [ ] T038 [US3] Add backward-compatible `ImageAttachment` support and trace-safe attachment metadata to provider message mapping in `src/core/providers.ts` and `src/core/tracing/tracedProvider.ts`
- [ ] T039 [US3] Move image requests onto `ChatProvider` and implement authoritative-content parsing plus validated blank-content reasoning fallback in `src/utils/vision.ts`
- [ ] T040 [US3] Implement fast, deliberate, and adaptive vision execution with bounded escalation and separate deliberate finalization in `src/utils/vision.ts`
- [ ] T041 [US3] Make screenshot description generics preserve caller Zod types and add internal observations, primary/secondary content, identity evidence, ambiguities, and classifiability in `src/tools/photos.ts`
- [ ] T042 [US3] Configure deterministic identity invariants, rubric evidence grading, adversarial alternatives, and required visible-text injection guardrails in `src/workflows/screenshotClassificationReview.ts`
- [ ] T043 [US3] Integrate adaptive vision evidence and reviewed classification into the screenshot workflow without granting revision new tools in `src/workflows/screenshotIngestion.ts`
- [ ] T044 [US3] Map evidence-based non-classifiability to `{ classification: "Rejected", name: "Unknown" }` while retaining provider/tool/reviewer failures as per-item errors in `src/workflows/screenshotIngestion.ts` and `src/tools/photos.ts`
- [ ] T045 [US3] Implement repeated baseline-versus-reviewed fixture evaluation with blank, accuracy, rejection, escalation, token, call, round, and latency metrics in `scripts/eval-reviewed-screenshots.ts`
- [ ] T046 [US3] Register the screenshot evaluation command in `package.json` and document its generated JSON artifact location in `scripts/eval-reviewed-screenshots.ts`

**Checkpoint**: User Story 3 fixes the observed Qwen3.5 blank-result failure and provides independently testable adaptive/reviewed classification behind its workflow configuration.

---

## Phase 6: User Story 4 - Understand Why an Agent Accepted or Rejected Work (Priority: P2)

**Goal**: Make every phase, candidate, reviewer, decision, consumed budget, and terminal reason queryable without recording image payloads or unrestricted private reasoning.

**Independent Test**: Export one fail -> revise -> pass run in memory and verify the AGENT/CHAIN/LLM/TOOL/EVALUATOR/GUARDRAIL hierarchy, candidate versions, reviewer attributes, budget counts, and final reason while confirming reasoning remains bounded and images are absent.

### Tests for User Story 4

- [ ] T047 [P] [US4] Add failing unit tests for stable review/execution attribute keys, max-severity derivation, reason codes, and bounded attribute serialization in `src/core/tracing/reviewSpans.test.ts`
- [ ] T048 [P] [US4] Add a failing in-memory exporter test for the full explore/finalize/review/revise/accept span tree and nested LLM/TOOL spans in `src/core/tracing/reviewedExecutionTrace.test.ts`
- [ ] T049 [P] [US4] Extend privacy regression tests to reject raw image/base64 attributes and retain the existing 2,000-character reasoning cap in `src/core/tracing/spans.test.ts` and `src/core/tracing/tracedProvider.test.ts`

### Implementation for User Story 4

- [ ] T050 [US4] Implement OpenInference evaluation metadata plus local review/candidate/budget/termination attribute helpers in `src/core/tracing/reviewSpans.ts`
- [ ] T051 [US4] Instrument exploration, finalization, revision, decision, budget exhaustion, and terminal outcomes with AGENT/CHAIN spans in `src/core/execution/explore.ts`, `src/core/execution/finalize.ts`, and `src/core/review/reviewedAgent.ts`
- [ ] T052 [US4] Instrument rubric/adversarial/deterministic reviewers as EVALUATOR and actual policy guardrails as GUARDRAIL spans in `src/core/review/reviewRunner.ts` and `src/core/review/modelReviewer.ts`
- [ ] T053 [US4] Add adaptive mode, escalation reason, response channel, and evidence-safe screenshot attributes without image payloads in `src/utils/vision.ts` and `src/workflows/screenshotIngestion.ts`

**Checkpoint**: User Story 4 independently explains every reviewed terminal outcome and identifies the consumed limit when a run exhausts.

---

## Phase 7: User Story 5 - Preserve Existing Workflows During Adoption (Priority: P3)

**Goal**: Retain legacy Agent, GeneratorGrader, fanout, provider fallback, and HTTP contracts while enabling reviewed execution per workflow with an immediate rollback path.

**Independent Test**: Run existing Agent, GeneratorGrader, fanout, provider, and endpoint suites with reviewed screenshots disabled and enabled. Verify unchanged callers retain their result shapes, GeneratorGrader preserves pass/revise/stop behavior, fallback providers still validate recovered results, and the flag changes only the selected workflow.

### Tests for User Story 5

- [ ] T054 [P] [US5] Expand compatibility tests for current GeneratorGrader thresholds, revision prompts, stopping semantics, structured/unstructured outputs, and model feedback treated as untrusted data in `src/agents/generatorGrader.test.ts`
- [ ] T055 [P] [US5] Add configuration tests for per-workflow reviewed screenshot enablement, legacy default/rollback, budget overrides, and invalid values in `src/core/config.test.ts`
- [ ] T056 [P] [US5] Lock existing `/screenshots/describe` and `/screenshots/classify` query, success, rejection, per-item error, and top-level error shapes in `src/http/app.test.ts`

### Implementation for User Story 5

- [ ] T057 [US5] Rebuild `GeneratorGraderAgent` as a one-rubric-reviewer `ReviewedAgent` compatibility facade while preserving its constructor, run overloads, and legacy stop mapping in `src/agents/generatorGrader.ts`
- [ ] T058 [US5] Add validated per-workflow reviewed screenshot mode and budget configuration with a legacy rollback default in `src/core/config.ts`, `.env.example`, and `src/workflows/screenshotIngestion.ts`
- [ ] T059 [US5] Preserve validated fallback parsing for providers without native schema enforcement and keep legacy Agent/fanout call signatures unchanged in `src/core/rawAgent.ts`, `src/core/providers.ts`, and `src/utils/fanout.ts`

**Checkpoint**: User Story 5 allows incremental opt-in and rollback without requiring changes from unmigrated callers.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Complete comparative evaluation, operator documentation, and repository-wide validation.

- [ ] T060 [P] Add a seeded material-defect/adversarial evaluation set and expected category/severity/action labels in `src/data/reviewed-execution/defects.json`, implement its runner in `scripts/eval-reviewed-agents.ts`, and register it in `package.json`
- [ ] T061 [P] Document reviewed workflow options, LM Studio Chat Completions configuration, auth behavior, reasoning compatibility, rollout, and rollback in `README.md` and `.env.example`
- [ ] T062 Run the deterministic and comparative validation scenarios from `specs/002-reviewed-agent-execution/quickstart.md` and correct any failures in the touched `src/` and `scripts/` files
- [ ] T063 Run `bun run typecheck`, `bun test`, and `git diff --check` and resolve all feature-related failures in `src/`, `scripts/`, and `specs/002-reviewed-agent-execution/`

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 Setup**: No dependencies.
- **Phase 2 Foundational**: Depends on Phase 1 and blocks all user stories.
- **Phase 3 / US1**: Depends on Foundation and supplies staged execution to later stories.
- **Phase 4 / US2**: Depends on US1's execution/finalization primitives.
- **Phase 5 / US3**: Depends on US1 and US2 for adaptive structured finalization and reviewed classification.
- **Phase 6 / US4**: Depends on US1 and US2; it can proceed in parallel with US3 once reviewed orchestration exists.
- **Phase 7 / US5**: GeneratorGrader migration depends on US2; the complete compatibility checkpoint also depends on US3 and US4 integrations.
- **Phase 8 Polish**: Depends on every user story selected for release.

### User story dependency graph

```text
Setup -> Foundation -> US1 -> US2 -> US3 -> US5
                              \-> US4 -/
```

- **US1 (P1)**: First independently deliverable MVP after Foundation.
- **US2 (P1)**: Adds first-class review/revision to the US1 producer; independently testable with scripted candidates.
- **US3 (P2)**: Uses US1/US2 but remains independently testable with screenshot fixtures and the unchanged endpoint contract.
- **US4 (P2)**: Uses US1/US2 and can be delivered/tested without enabling screenshot migration.
- **US5 (P3)**: Validates and completes incremental adoption across legacy and migrated workflows.

### Within each user story

1. Write the listed tests first and confirm they fail for the intended missing behavior.
2. Implement shared types before services that consume them.
3. Implement pure validation/policy before model-backed orchestration.
4. Complete integration and compatibility work only after lower-level tests pass.
5. Stop at the phase checkpoint and run that story's independent test before proceeding.

## Parallel Opportunities

- T001 and T002 can proceed independently.
- T003 and T005 can be authored in parallel; T004 and T006 then implement separate provider/concurrency seams.
- US1 test tasks T007-T010 can be authored in parallel; after T011-T012, exploration T013 and finalization T014 can be implemented in parallel.
- US2 tests T017-T021 can be authored in parallel; after T022-T025, reviewer adapters T026-T029 can be implemented in parallel.
- US3 tests/fixtures T032-T037 can be authored in parallel; after provider/vision work T038-T040, review configuration T042 and generic photo typing T041 can proceed in parallel.
- US4 tests T047-T049 can be authored in parallel; instrumentation can then be divided between execution T051, review T052, and vision T053 after T050 defines attributes.
- US5 tests T054-T056 can be authored in parallel before the three compatibility implementations.
- US3 and US4 can proceed concurrently after US2; final US5 contract verification waits for both.

## Parallel Example: User Story 1

```text
Task T007: Budget and exhaustion tests in src/core/execution/types.test.ts and errors.test.ts
Task T008: Exploration/tool evidence tests in src/core/execution/explore.test.ts
Task T009: Structured finalization/repair tests in src/core/execution/finalize.test.ts
Task T010: Agent integration and conversational compatibility tests in src/core/rawAgent.test.ts
```

## Parallel Example: User Story 2

```text
Task T026: Deterministic reviewer in src/core/review/deterministicReviewer.ts
Task T027: Rubric grader in src/core/review/rubricGrader.ts
Task T028: Adversarial reviewer in src/core/review/adversarialReviewer.ts
Task T029: Guardrail reviewer in src/core/review/guardrailReviewer.ts
```

## Parallel Example: User Story 3

```text
Task T033: Response-channel vision regressions in src/utils/vision.test.ts
Task T034: Adaptive mode tests in src/utils/visionModes.test.ts
Task T035: Generic rich description tests in src/tools/photos.test.ts
Task T037: Labeled screenshot manifests in src/data/reviewed-screenshots/
```

## Parallel Example: User Story 4

```text
Task T051: Execution/finalization/revision instrumentation
Task T052: Reviewer and guardrail instrumentation
Task T053: Vision and screenshot instrumentation
```

## Parallel Example: User Story 5

```text
Task T054: GeneratorGrader compatibility tests
Task T055: Per-workflow configuration tests
Task T056: HTTP endpoint contract tests
```

---

## Implementation Strategy

### MVP first: User Story 1

1. Complete Setup and Foundation.
2. Implement US1's staged exploration and finalization.
3. Run US1 independently and verify completed tools are not repeated during formatting repair.
4. Stop here for the smallest useful deployment: structured agents can reason/use tools without premature schema constraints, while existing behavior remains available.

### Incremental delivery

1. **Foundation + US1**: provider normalization and staged structured execution.
2. **US2**: independent graders, adversaries, guardrails, deterministic decisions, and revision.
3. **US3**: adaptive LM Studio vision and reviewed screenshot classification behind workflow opt-in.
4. **US4**: complete operational trace hierarchy and privacy checks; may ship alongside US3.
5. **US5**: migrate GeneratorGrader, validate compatibility, and expose rollback configuration.
6. **Polish**: run comparative evaluations and full quality gates before widening workflow adoption.

### Risk-first sequencing inside the MVP

1. Normalize reasoning controls/results and cancellation at the provider boundary.
2. Establish independent budget/error types.
3. Prove exploration and finalization separately with scripted calls.
4. Refactor the existing Agent only after those primitives pass.
5. Keep the immediate reasoning-channel vision regression independently cherry-pickable if production needs it before the complete reviewed-agent rollout.

## Notes

- `[P]` means safe parallel work only after the stated phase/task prerequisites.
- Tests are intentionally explicit because SC-001 through SC-014 require automated or comparative evidence.
- Model reviewer output is untrusted data; never promote it or visible screenshot text to a system message.
- Do not record base64 image data, secrets, unrestricted tool payloads, or raw reasoning in reviewed results/traces.
- Keep live LM Studio smoke/evaluation runs opt-in; deterministic scripted tests remain part of `bun test`.
- Commit after each task or coherent task group and validate at every checkpoint.
