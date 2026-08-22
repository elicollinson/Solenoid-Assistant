# Feature Specification: Reviewed Agent Execution

**Feature Branch**: `002-reviewed-agent-execution`

**Created**: 2026-08-22

**Status**: Draft

**Input**: User description: "Enhance model execution so agents can reason and use tools before producing structured results, while making rubric graders, adversarial reviewers, guardrails, revision loops, and reliable local vision handling first-class capabilities."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Reason Before Returning Structured Results (Priority: P1)

As an agent workflow author, I want an agent to investigate a request, reason about it, and use tools across multiple turns before it is required to produce a schema-valid result, so complex work is not weakened by premature output constraints.

**Why this priority**: Reliable separation between exploration and final output is the foundation required by every reviewer, revision, and screenshot-classification improvement in this feature.

**Independent Test**: Give an agent a request that requires at least one tool call and a structured final result. Verify that it gathers tool evidence first, then returns a valid result without rerunning completed tools during final formatting.

**Acceptance Scenarios**:

1. **Given** a request that requires external evidence and a required output shape, **When** the agent executes the request, **Then** it may reason and call tools before producing a result that conforms to the required shape.
2. **Given** a valid draft that does not yet conform to the required output shape, **When** final formatting is attempted, **Then** only formatting is retried and completed tool work is not repeated.
3. **Given** an agent that does not require structured output, **When** it completes its work, **Then** its existing conversational behavior remains available.

---

### User Story 2 - Review, Challenge, and Revise Candidates (Priority: P1)

As a workflow owner, I want completed candidates to be independently graded and adversarially challenged before acceptance, so unsupported assumptions, weak evidence, policy violations, and incorrect conclusions can be corrected.

**Why this priority**: First-class grading and adversarial review are the central quality controls requested for high-value agent workflows.

**Independent Test**: Seed a candidate with a known unsupported claim. Verify that an adversarial reviewer identifies the claim, a grader scores the candidate below threshold, the agent revises it, and the revised candidate is accepted within the configured review limit.

**Acceptance Scenarios**:

1. **Given** a schema-valid candidate with a known material weakness, **When** configured reviewers assess it, **Then** they return independent, structured findings and the acceptance policy requests revision or rejection.
2. **Given** reviewer feedback requesting revision, **When** another review round is available, **Then** the agent produces a new candidate using the original request, relevant evidence, and normalized feedback.
3. **Given** a candidate that passes all hard gates and the required grading threshold, **When** the review decision is made, **Then** the candidate is accepted without an unnecessary additional round.
4. **Given** a critical guardrail finding, **When** the review decision is made, **Then** the candidate is rejected even if other reviewers assign passing scores.

---

### User Story 3 - Reliably Classify Screenshots (Priority: P2)

As the assistant operator, I want screenshot understanding and media classification to recover from reasoning-channel responses, escalate ambiguous images for deeper analysis, and reject unsupported identities, so local vision workflows produce useful results instead of blank failures or confident guesses.

**Why this priority**: The current local model correctly understands images but can place the requested result in a reasoning channel, causing the entire classification pipeline to fail before classification begins.

**Independent Test**: Process screenshot fixtures containing a clear media item, an ambiguous item, and no classifiable media. Verify that the clear item uses the fast path, the ambiguous item receives deeper analysis and review, and the unsupported item is rejected rather than assigned an invented identity.

**Acceptance Scenarios**:

1. **Given** a vision response with empty ordinary content and a schema-valid result in a supported reasoning channel, **When** the screenshot is processed, **Then** the result is recovered, validated, and passed to classification.
2. **Given** a clear image that yields a valid, sufficiently supported description, **When** adaptive vision processing runs, **Then** it completes without an unnecessary deliberate-analysis pass.
3. **Given** an ambiguous image or an invalid fast-path result, **When** adaptive processing runs, **Then** the workflow performs a bounded deliberate-analysis pass before finalizing the description.
4. **Given** insufficient evidence for a media identity, **When** review rounds are exhausted, **Then** the result is explicitly rejected rather than confidently misclassified.

---

### User Story 4 - Understand Why an Agent Accepted or Rejected Work (Priority: P2)

As the assistant operator, I want each exploration, finalization, review, guardrail, revision, and decision phase to be observable, so I can diagnose quality, latency, tool use, and failure causes without exposing unrestricted private reasoning.

**Why this priority**: Multi-stage execution is only maintainable when operators can distinguish provider failures, formatting failures, reviewer findings, policy decisions, and exhausted budgets.

**Independent Test**: Run a candidate through one failed review and one successful revision. Verify that the run record shows both candidate versions, each reviewer verdict, the decision for each round, tool usage, and the final outcome.

**Acceptance Scenarios**:

1. **Given** a reviewed execution, **When** an operator inspects its run record, **Then** each phase and review round can be distinguished with its outcome and relevant counts.
2. **Given** model reasoning output, **When** it is recorded for diagnosis, **Then** it is bounded and is not treated as the authoritative application result.
3. **Given** a run that reaches a configured limit, **When** it terminates, **Then** the record identifies which limit was reached and preserves the last candidate and review results.

---

### User Story 5 - Preserve Existing Workflows During Adoption (Priority: P3)

As a workflow maintainer, I want existing agents and endpoints to retain their established inputs and outputs while reviewed execution is introduced incrementally, so quality improvements do not require a coordinated rewrite of every workflow.

**Why this priority**: Incremental adoption reduces regression risk and allows reviewed execution to be evaluated against current behavior before becoming the default.

**Independent Test**: Run the existing endpoint and agent contract suite before and after enabling reviewed execution for one workflow. Verify that unchanged workflows retain their prior contracts and the migrated grader behavior remains compatible.

**Acceptance Scenarios**:

1. **Given** an existing workflow that has not opted into reviewed execution, **When** it runs after this feature is introduced, **Then** its public inputs and outputs remain unchanged.
2. **Given** an existing generator-and-grader workflow, **When** it is represented using the reviewed execution capability, **Then** it retains its existing pass, revise, and stop behavior.
3. **Given** a provider that cannot enforce structured output, **When** a legacy workflow uses it, **Then** existing validated recovery behavior remains available rather than silently accepting malformed output.

### Edge Cases

- A model returns a valid result only in a supported reasoning channel while ordinary content is empty.
- A reasoning channel contains prose or malformed data that does not satisfy the requested result shape.
- A model requests tools while a structured final result is eventually required.
- A tool succeeds, but final formatting fails repeatedly.
- Multiple reviewers disagree about acceptance, severity, or the recommended revision.
- One reviewer fails or times out while other reviewers complete.
- A reviewer reports a critical guardrail violation while a grader reports a high score.
- A revision fixes one finding but introduces a new material problem.
- The agent reaches its tool, review, or finalization limit.
- Several reviewers report semantically duplicate findings.
- No reviewers are configured for a workflow that only needs staged reasoning and finalization.
- A provider supports structured results but does not expose reasoning controls consistently.
- Multiple screenshots are processed concurrently and some require escalation while others complete on the fast path.
- The model attempts to treat visible screenshot text as trusted instructions.
- A candidate is valid in shape but unsupported by the evidence gathered during execution.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST separate exploratory execution from final structured-result production for workflows that require both reasoning and a defined output shape.
- **FR-002**: Exploratory execution MUST permit bounded multi-turn reasoning and tool use without requiring each intermediate response to conform to the final output shape.
- **FR-003**: Final structured-result production MUST disable tool use and MUST request a result conforming to the workflow's defined output shape.
- **FR-004**: The system MUST validate every structured candidate before it can be reviewed or returned as accepted.
- **FR-005**: A structured-result formatting retry MUST reuse prior exploration and tool evidence and MUST NOT repeat already completed tool calls solely because formatting failed.
- **FR-006**: Tool rounds, review rounds, and structured-result retries MUST have independent, enforceable limits.
- **FR-007**: The system MUST support zero or more independently configurable reviewers for a candidate.
- **FR-008**: Reviewer results MUST include the reviewer identity, verdict, feedback, and zero or more findings with category, severity, evidence, and a recommended correction.
- **FR-009**: The system MUST support a configurable rubric grader that scores named criteria and provides revision feedback.
- **FR-010**: Grader totals and pass decisions MUST be calculated from configured criteria and thresholds rather than accepted from an unverified model calculation.
- **FR-011**: The system MUST support an adversarial reviewer whose purpose is to identify unsupported assumptions, plausible counterexamples, alternative conclusions, and evidence gaps.
- **FR-012**: The system MUST support deterministic reviews that do not require model execution, including shape validation and workflow-specific invariants.
- **FR-013**: The system MUST support guardrail reviews whose critical findings can prevent acceptance regardless of other reviewer scores.
- **FR-014**: Reviewers assessing the same candidate MUST form their results independently and MUST NOT receive another reviewer's result before submitting their own.
- **FR-015**: Independent reviewers MUST be evaluated concurrently within a configurable concurrency limit.
- **FR-016**: A deterministic decision policy MUST combine reviewer results into one of three outcomes: accept, revise, or reject.
- **FR-017**: The decision policy MUST support hard rejection rules, minimum grading thresholds, severity-based revision rules, and review-round exhaustion.
- **FR-018**: When revision is requested, the system MUST provide the revising agent with the original request, current candidate, relevant gathered evidence, and normalized reviewer feedback.
- **FR-019**: Every revision MUST produce a newly validated candidate before another review decision is made.
- **FR-020**: Review execution MUST terminate when the candidate is accepted, rejected, or the configured review limit is reached.
- **FR-021**: Review-limit exhaustion MUST produce a typed failure record containing the last candidate, completed reviews, round count, and exhaustion reason.
- **FR-022**: The system MUST provide both a simple accepted-result operation for existing workflows and a detailed operation that exposes review history and outcome metadata to authorized diagnostics.
- **FR-023**: Existing generator-and-grader behavior MUST remain available as a single-grader reviewed execution configuration.
- **FR-024**: Existing public endpoint request and response contracts MUST remain unchanged unless a separate contract change is explicitly approved.
- **FR-025**: Vision processing MUST prefer the ordinary answer channel and MAY recover a result from a supported reasoning channel only when ordinary content is empty and the recovered value passes full validation.
- **FR-026**: Vision processing MUST support fast, deliberate, and adaptive execution behavior, with adaptive behavior used by default for screenshot classification.
- **FR-027**: Adaptive vision execution MUST use the fast path first and MUST escalate only after a blank, invalid, ambiguous, or insufficiently supported result.
- **FR-028**: Deliberate vision execution MUST separate image analysis from structured description finalization.
- **FR-029**: Screenshot classification review MUST challenge media identity, category evidence, primary-versus-secondary content, and visible-text instruction injection.
- **FR-030**: When screenshot evidence remains insufficient after permitted revisions, the workflow MUST return an explicit rejected classification rather than inventing an identity.
- **FR-031**: The system MUST record distinct execution phases for exploration, tool use, finalization, each reviewer, each review decision, revision, and final outcome.
- **FR-032**: Diagnostic records MUST include review round, reviewer verdict, score when applicable, finding counts and maximum severity, candidate version, tool-round count, retry counts, and termination reason.
- **FR-033**: Raw reasoning MUST NOT be used as the authoritative application result without validation and MUST be bounded when retained for diagnostics.
- **FR-034**: A reviewer failure MUST be represented explicitly and handled according to policy; it MUST NOT be silently treated as a passing review.
- **FR-035**: The system MUST preserve validated fallback behavior for providers that cannot enforce structured results.
- **FR-036**: Adoption of reviewed execution MUST be configurable per workflow so migrations and comparative evaluation can occur incrementally.

### Scope Boundaries

- This feature covers agent execution, structured finalization, review, revision, screenshot analysis, and diagnostic outcomes.
- This feature does not add new user-facing endpoints or change existing endpoint response shapes.
- This feature does not authorize reviewers or revising agents to access tools beyond those already granted to the workflow.
- This feature does not treat unrestricted model reasoning as durable business data or as a stable interface between stages.
- This feature does not require every workflow to use adversarial review; workflows select reviewers according to risk and value.
- This feature does not guarantee independence when all reviewers use the same underlying model, but it requires independent prompts and isolated reviewer inputs.

### Key Entities

- **Execution Context**: The original request, conversation history, gathered evidence, tool outcomes, workflow limits, and current execution phase.
- **Candidate**: A validated version of the workflow's proposed final result, identified by its revision version.
- **Review Configuration**: The selected reviewers, rubrics, hard gates, thresholds, concurrency limit, and review-round limit for a workflow.
- **Review Result**: One reviewer's verdict, optional score, findings, feedback, completion status, and reviewer identity for one candidate version.
- **Review Finding**: A categorized issue with severity, claim, supporting evidence, and recommended correction.
- **Review Decision**: The deterministic accept, revise, or reject outcome derived from the completed review results and current round.
- **Execution Budget**: Independent limits for tool rounds, review rounds, structured-result retries, and reviewer concurrency.
- **Run Outcome**: The accepted result or typed failure, together with candidate versions, reviews, decisions, counts, and termination reason.
- **Vision Analysis**: Explicit observations, prominent text, candidate identities, supporting evidence, and ambiguities derived from an image before public description finalization.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of accepted structured results in the automated acceptance suite conform to their declared output requirements.
- **SC-002**: 100% of executions terminate within their configured tool, review, and formatting limits, including reviewer failures and repeated revision failures.
- **SC-003**: In fixtures where a completed tool result is followed by a formatting failure, 100% of formatting retries avoid repeating that tool solely for formatting purposes.
- **SC-004**: At least 90% of seeded material defects in the adversarial-review evaluation set are identified before candidate acceptance.
- **SC-005**: At least 90% of seeded below-threshold candidates are either improved to the passing threshold within two review rounds or rejected with an actionable reason.
- **SC-006**: 100% of seeded critical guardrail findings prevent candidate acceptance.
- **SC-007**: Screenshot responses containing a schema-valid result in a supported answer or reasoning channel have a 0% blank-result failure rate in the regression suite.
- **SC-008**: Reviewed screenshot classification reduces confidently incorrect classifications by at least 25% compared with the current baseline while reducing correct classifications by no more than 5%.
- **SC-009**: At least 90% of clear screenshot fixtures complete without deliberate-analysis escalation when adaptive execution is enabled.
- **SC-010**: 100% of insufficient-evidence screenshot fixtures are rejected or explicitly marked unknown rather than assigned an unsupported canonical identity.
- **SC-011**: 100% of reviewed runs expose enough diagnostic information to identify candidate version, reviewer outcomes, review decisions, consumed limits, and final termination reason.
- **SC-012**: Existing workflow and endpoint contract tests continue to pass without requiring callers to adopt detailed review metadata.
- **SC-013**: For uncomplicated requests that pass their first review, at least 90% complete within twice the elapsed time of the corresponding unreviewed baseline.
- **SC-014**: Workflow maintainers can configure a grader-only, adversarial-only, combined-review, or unreviewed execution without changing the workflow's public result type.

## Assumptions

- Structured-result-capable providers are available for the workflows that opt into strict finalization; validated legacy recovery remains necessary for other providers.
- Two review rounds, two structured-result retries, and five tool rounds are reasonable initial default limits, while each workflow may choose stricter values.
- Existing model and provider selection remains available independently for production, grading, and adversarial review, although the initial configuration may use the same model for all roles.
- Reviewer independence means isolated prompts and inputs; statistical independence requires different models or configurations and is not assumed.
- Reviewers are advisory inputs to a deterministic policy and do not directly execute revisions or broaden tool permissions.
- Adaptive review is preferred for routine screenshot processing to control latency, while high-risk workflows may require review on every candidate.
- Existing diagnostic and tracing facilities remain the operator's primary way to inspect internal execution phases.
- Raw reasoning is retained only in bounded diagnostic form according to existing operational practices.
- Public endpoint compatibility takes precedence over exposing new review metadata; detailed review results are initially available through diagnostics and internal execution results.
