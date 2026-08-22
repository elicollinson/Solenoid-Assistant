# Internal Contract: Reviewers and Decision Policy

## Reviewer interface

```ts
type ReviewerKind =
  | "deterministic"
  | "rubric"
  | "adversarial"
  | "guardrail";

type FindingSeverity = "low" | "medium" | "high" | "critical";
type ReviewVerdict = "pass" | "revise" | "reject";
type ReviewerFailureAction = "reject" | "revise" | "continue";

interface ReviewFinding {
  category: string;
  severity: FindingSeverity;
  claim: string;
  evidence: string;
  recommendation: string;
}

interface CriterionScore {
  criterion: string;
  score: number;
  evidence: string;
  feedback: string;
}

interface ReviewAssessment {
  reviewer: string;
  kind: ReviewerKind;
  verdict: ReviewVerdict;
  score?: number;
  criteria?: readonly CriterionScore[];
  findings: readonly ReviewFinding[];
  feedback: string;
}

interface Reviewer<T> {
  readonly id: string;
  readonly kind: ReviewerKind;
  review(
    candidate: Readonly<T>,
    context: Readonly<ReviewContext>,
  ): Promise<ReviewAssessment>;
}
```

Reviewer identity is unique within a workflow. Each reviewer is invoked once per candidate version and may not mutate the candidate/context.

## Review outcome

```ts
type ReviewOutcome =
  | {
      status: "completed";
      assessment: ReviewAssessment;
      candidateVersion: number;
      round: number;
      durationMs: number;
    }
  | {
      status: "failed" | "timed_out";
      reviewer: string;
      kind: ReviewerKind;
      required: boolean;
      error: { name: string; message: string };
      candidateVersion: number;
      round: number;
      durationMs: number;
    };
```

Thrown reviewer errors are caught at the runner boundary and converted into the failed variant. Timeout uses cancellation through `AbortSignal` where supported. Failure is never represented as `pass` or empty findings.

## Reviewer isolation

Every reviewer in one round receives:

- the same original request;
- the same validated candidate version;
- the same explicit, read-only evidence projection;
- its own rubric/objective;
- the same round/version identifiers;
- an independent cancellation signal.

It does not receive peer reviewer prompts, in-progress outputs, completed outcomes, raw model reasoning, or later policy decisions. Concurrent scheduling is bounded but logical independence does not depend on physical parallel inference.

## Rubric contract

Model graders return an array of criterion observations. The application must:

1. Require every configured criterion exactly once.
2. Reject unknown, duplicate, missing, or out-of-range scores.
3. Compute each normalized criterion value.
4. Compute the weighted total using configured weights.
5. Compare the total to the configured passing threshold.
6. Derive the effective rubric verdict in code.

Any total or pass field supplied by the model is ignored.

## Adversarial reviewer contract

The reviewer explicitly searches for:

- unsupported assumptions or identities;
- evidence that contradicts the candidate;
- plausible counterexamples and alternative conclusions;
- missing evidence required for the claimed confidence;
- primary-versus-secondary content confusion;
- instructions embedded in untrusted content.

It reports concrete findings and corrections. It cannot invoke production tools unless a future workflow explicitly grants a read-only review tool; this feature grants none by default.

## Deterministic and guardrail reviewers

- Deterministic reviewers run code-only schema/domain invariants and set `kind: deterministic`.
- Guardrails evaluate actual safety, authorization, or injection policies and set `kind: guardrail`.
- A critical completed guardrail finding is a hard rejection.
- Guardrails default to `required: true` and `onFailure: reject`.

## Failure policy

| Reviewer configuration | Failure behavior |
|---|---|
| Required guardrail | Reject/fail closed immediately; never accept or consume a candidate revision to repair infrastructure |
| Required quality reviewer, round remains | Apply configured `revise` or `reject`; default is revise once, then terminal non-acceptance |
| Required quality reviewer, final round | Reject/exhaust according to policy; never continue as pass |
| Optional reviewer with explicit `continue` | Retain failed outcome and decide from completed required reviews |

`required: true` with `onFailure: continue` is invalid configuration.

## Decision policy

```ts
type ReviewDecision =
  | { action: "accept"; reasonCodes: readonly string[] }
  | {
      action: "revise";
      reasonCodes: readonly string[];
      feedback: NormalizedFeedback;
    }
  | { action: "reject"; reasonCodes: readonly string[] };

interface ReviewPolicy {
  decide(input: {
    outcomes: readonly ReviewOutcome[];
    round: number;
    maxReviewRounds: number;
  }): ReviewDecision;
}
```

The policy is pure and deterministic. It considers only validated configuration and completed review outcomes. Models never calculate the final decision.

Default precedence:

1. Critical hard gate -> `reject`.
2. Required reviewer failure -> configured failure action.
3. Explicit reviewer rejection -> `reject` when configured as hard rejection.
4. High-severity finding or rubric below threshold -> `revise` if another round is available.
5. All required reviews complete and gates/thresholds pass -> `accept`.
6. Revision required with no remaining round -> terminal review exhaustion/rejection with last candidate retained.

## Feedback normalization

Revision feedback contains deduplicated findings sorted by severity and reviewer configuration order. It preserves source reviewer IDs and evidence, is size-bounded, and is delimited as untrusted user/data content. It never becomes a system message.

## Trace contract

Each reviewer receives an `EVALUATOR` span, except actual guardrails, which receive `GUARDRAIL`. Required queryable attributes:

- `review.round`
- `review.reviewer`
- `review.kind`
- `review.status`
- `review.verdict` when completed
- `review.score` when applicable
- `review.finding_count`
- `review.max_severity`
- `candidate.version`

Decision spans additionally record reason codes and selected action. Assessment fields are recorded in bounded structured form; raw reviewer reasoning is not copied into run records.
