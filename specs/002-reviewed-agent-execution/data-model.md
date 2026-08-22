# Phase 1 Data Model: Reviewed Agent Execution

This feature introduces in-memory execution and review records. It does not add a database schema. TypeScript discriminated unions and Zod schemas enforce the model at runtime; trace serialization contains only bounded, non-sensitive projections.

## Enumerations

| Type | Values |
|---|---|
| `ReasoningMode` | `provider-default`, `enabled`, `disabled` |
| `ExecutionPhase` | `exploring`, `finalizing`, `reviewing`, `revising`, `accepted`, `rejected`, `exhausted`, `failed` |
| `ReviewerKind` | `deterministic`, `rubric`, `adversarial`, `guardrail` |
| `ReviewerStatus` | `completed`, `failed`, `timed_out` |
| `ReviewVerdict` | `pass`, `revise`, `reject` |
| `FindingSeverity` | `low`, `medium`, `high`, `critical` |
| `DecisionAction` | `accept`, `revise`, `reject` |
| `FailureAction` | `reject`, `revise`, `continue` |
| `RunStatus` | `accepted`, `rejected`, `exhausted`, `failed` |
| `VisionMode` | `fast`, `deliberate`, `adaptive` |
| `Classifiability` | `clear_media`, `clear_non_media`, `ambiguous`, `insufficient_evidence` |

## ExecutionBudget

Independent limits for one run.

| Field | Type | Default | Validation/meaning |
|---|---:|---:|---|
| `maxToolRounds` | integer | 5 | `>= 0`; one round is one assistant response containing one or more tool calls |
| `maxReviewRounds` | integer | 2 | `>= 0`; counts candidate assessments, so 2 allows initial v1 plus revised v2 |
| `maxFinalizationRetries` | integer | 2 | `>= 0`; retries after the initial finalization attempt |
| `reviewerConcurrency` | integer | 4 | `>= 1`; workflows using one local GPU may choose 1-2 |
| `reviewerTimeoutMs` | integer | workflow configured | `> 0`; propagated through `AbortSignal` |

**Invariants**:

- Budget counters are monotonic and scoped to their corresponding stage.
- A finalization retry never increments `toolRounds`.
- A reviewer timeout does not silently continue model execution when the adapter supports cancellation.
- Zero review rounds is valid only when zero reviewers are configured; the validated candidate is then accepted without a review phase.

## ExecutionContext

Immutable input shared across orchestration stages.

| Field | Type | Meaning |
|---|---|---|
| `runId` | string | Unique correlation identifier |
| `workflow` | string | Stable workflow/agent identifier |
| `request` | unknown/string | Original typed request or rendered prompt input |
| `conversation` | `readonly ChatMessage[]` | Workflow-owned conversation history |
| `evidence` | `EvidenceSnapshot` | Explicit observations and tool results collected in exploration |
| `budgets` | `ExecutionBudget` | Validated limits |
| `startedAt` | timestamp | Run start |
| `abortSignal` | AbortSignal? | Caller cancellation propagated to tools/providers/reviewers when supported |

Raw model reasoning is not a field. It remains a bounded provider-span diagnostic only.

## EvidenceSnapshot

The stable stage boundary between exploration, finalization, review, and revision.

| Field | Type | Meaning |
|---|---|---|
| `draft` | string? | Ordinary assistant content produced after exploration |
| `toolResults` | `readonly ToolEvidence[]` | Completed tool outputs in execution order |
| `observations` | `readonly string[]` | Explicit workflow-owned observations |
| `transcript` | `readonly ChatMessage[]` | Conversation required for finalization continuity |

### ToolEvidence

| Field | Type | Meaning |
|---|---|---|
| `toolCallId` | string | Provider tool-call correlation ID |
| `toolName` | string | Validated tool name |
| `arguments` | unknown | Validated invocation arguments |
| `result` | unknown | Bounded/serializable output supplied to the model |
| `status` | `completed` or `failed` | Tool outcome |

**Invariants**:

- Only tools authorized on the original workflow may appear.
- A formatting retry reads this snapshot but cannot invoke tools.
- Reviewers receive a read-only projection and never peer review results.

## CandidateVersion<T>

A structured workflow result that passed the workflow's Zod schema.

| Field | Type | Meaning |
|---|---|---|
| `version` | positive integer | Starts at 1; increases by one after every revision |
| `value` | `Readonly<T>` | Locally validated candidate |
| `createdBy` | `initial` or `revision` | Production stage |
| `finalizationAttempts` | positive integer | Attempts used for this version |
| `createdAt` | timestamp | Candidate creation time |

**Invariants**:

- An invalid value never becomes a `CandidateVersion` and cannot be reviewed.
- Version numbers are strictly increasing and unique within one run.
- A candidate is immutable once review begins.

## ReviewConfiguration<T>

| Field | Type | Meaning |
|---|---|---|
| `reviewers` | `readonly ReviewerConfig<T>[]` | Zero or more isolated reviewers |
| `policy` | `ReviewPolicyConfig` | Deterministic thresholds and precedence |
| `concurrency` | integer | Effective reviewer fanout limit |
| `maxRounds` | integer | Effective review-round limit |

### ReviewerConfig<T>

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Unique within the workflow |
| `kind` | `ReviewerKind` | Reviewer semantics/span kind |
| `required` | boolean | Whether failure may be bypassed |
| `onFailure` | `FailureAction` | Required reviewers cannot use `continue` |
| `timeoutMs` | positive integer? | Per-reviewer override |
| `reviewer` | `Reviewer<T>` | Deterministic or model-backed implementation |

**Defaults**:

- Guardrails: `required: true`, `onFailure: reject`.
- Quality graders/adversaries: `required: true`, `onFailure: revise`, with rejection/exhaustion after the final round.
- `continue` is allowed only for an explicitly optional reviewer.

## RubricDefinition

| Field | Type | Meaning |
|---|---|---|
| `criteria` | `readonly RubricCriterion[]` | Named scoring dimensions |
| `passingScore` | number | Locally applied normalized threshold |

### RubricCriterion

| Field | Type | Meaning |
|---|---|---|
| `name` | string | Unique stable criterion key |
| `description` | string | Model instruction |
| `minScore` | number | Inclusive lower bound |
| `maxScore` | number | Inclusive upper bound |
| `weight` | positive number | Relative weight |

**Invariants**:

- A model assessment contains every configured criterion exactly once and no unknown criterion.
- Every score is within the configured range.
- The application computes normalized weighted totals and verdicts; model totals/pass flags are ignored.

## ReviewContext

The immutable input given independently to one reviewer.

| Field | Type | Meaning |
|---|---|---|
| `request` | unknown/string | Original request |
| `candidateVersion` | integer | Version under assessment |
| `round` | positive integer | Review round |
| `evidence` | read-only evidence projection | Explicit tool/observation evidence |
| `objective` | string/rubric | This reviewer's isolated purpose |
| `abortSignal` | AbortSignal | Timeout/caller cancellation |

It intentionally excludes raw reasoning and other reviewers' outcomes.

## ReviewFinding

| Field | Type | Meaning |
|---|---|---|
| `category` | string | Stable issue category |
| `severity` | `FindingSeverity` | Policy input |
| `claim` | string | Specific issue found |
| `evidence` | string | Candidate/evidence basis, not hidden reasoning |
| `recommendation` | string | Actionable correction |

Findings may be normalized/deduplicated for revision, while original reviewer assessments remain in detailed history.

## CriterionScore

| Field | Type | Meaning |
|---|---|---|
| `criterion` | string | Exact rubric criterion name |
| `score` | number | Validated raw criterion score |
| `evidence` | string | Basis for the score |
| `feedback` | string | Criterion-specific correction |

## ReviewAssessment

Produced only by a successfully completed reviewer.

| Field | Type | Meaning |
|---|---|---|
| `reviewer` | string | Reviewer ID |
| `kind` | `ReviewerKind` | Reviewer type |
| `verdict` | `ReviewVerdict` | Advisory verdict |
| `score` | number? | Application-computed normalized score for rubric graders |
| `criteria` | `readonly CriterionScore[]`? | Rubric detail |
| `findings` | `readonly ReviewFinding[]` | Zero or more findings |
| `feedback` | string | Summary feedback |

## ReviewOutcome

Discriminated union for one reviewer and one candidate version.

### Completed

`status: completed`, plus `assessment`, `candidateVersion`, `round`, timing metadata.

### Failed or timed out

`status: failed | timed_out`, plus reviewer ID/kind, `required`, serializable error name/message, candidate version, round, timing metadata.

**Invariant**: Failure is never converted to an empty assessment or passing verdict.

## ReviewDecision

Pure policy output for one completed round.

| Field | Type | Meaning |
|---|---|---|
| `action` | `accept`, `revise`, or `reject` | Deterministic next transition |
| `reasonCodes` | `readonly string[]` | Stable machine-queryable reasons |
| `feedback` | normalized feedback? | Present for revision; delimited as untrusted data |
| `decidedAt` | timestamp | Decision time |

Policy precedence:

1. Completed critical guardrail/hard rejection.
2. Required reviewer failure according to configured failure action.
3. High-severity findings or below-threshold rubric result.
4. Acceptance if every required gate completed and passed.
5. Exhaustion/rejection when revision is requested and no round remains.

## ReviewRound

| Field | Type | Meaning |
|---|---|---|
| `round` | positive integer | 1-based review assessment number |
| `candidateVersion` | positive integer | Candidate reviewed |
| `outcomes` | `readonly ReviewOutcome[]` | One entry per configured reviewer, stable config order |
| `decision` | `ReviewDecision` | Pure policy result |

## ReviewedRunResult<T>

All variants include `runId`, `status`, `terminationReason`, candidate history, review rounds, usage counters, timing, and bounded error metadata.

### Accepted

- `status: accepted`
- `value: T`
- `acceptedCandidate: CandidateVersion<T>`

### Rejected

- `status: rejected`
- `lastCandidate?: CandidateVersion<T>`
- `reasonCodes`

### Exhausted

- `status: exhausted`
- `limit: tool_rounds | review_rounds | finalization_retries`
- `lastCandidate?`, completed rounds, and counter values

### Failed

- `status: failed`
- `phase`, serializable error, `lastCandidate?`, and completed history

`runDetailed()` returns this union. `run()` returns the accepted `value`; otherwise it throws a typed `ReviewedRunError` whose serializable `result` is the corresponding non-accepted variant.

## VisionAnalysis

Internal evidence-rich output, never serialized directly by existing endpoints.

| Field | Type | Meaning |
|---|---|---|
| `app` | string | Observed application/context |
| `summary` | string | Evidence-bound description |
| `observations` | `readonly string[]` | Direct visual observations |
| `prominentText` | `readonly string[]` | Visible text treated as untrusted data |
| `primaryContent` | string? | Main media/content observation |
| `secondaryContent` | `readonly string[]` | Ads, overlays, related/secondary items |
| `identityCandidates` | candidate/evidence pairs | Possible identities with support, not final truth |
| `ambiguities` | `readonly string[]` | Missing/contradictory evidence |
| `classifiability` | `Classifiability` | Fast-path/escalation/rejection signal |
| `modeUsed` | `fast` or `deliberate` | Actual completion mode |

**Invariants**:

- Visible text is evidence, never executable instruction.
- A public identity/classification requires supporting visual/tool evidence.
- `ambiguous` or invalid fast output causes at most one bounded deliberate pass in adaptive mode.
- Remaining insufficient evidence maps to an existing domain rejection, not an invented identity.

## State transitions

```text
start -> exploring
exploring -> finalizing | exhausted | failed
finalizing -> reviewing | accepted(no reviewers) | exhausted | failed
reviewing -> accepted | revising | rejected | exhausted | failed
revising -> finalizing | exhausted | failed
accepted | rejected | exhausted | failed -> terminal
```

Forbidden transitions:

- `finalizing -> exploring` on formatting failure.
- `reviewing -> exploring` solely to revise a candidate.
- any terminal state -> non-terminal state.
- review of an unvalidated candidate.
- reviewer execution with results from another reviewer in the same round.
