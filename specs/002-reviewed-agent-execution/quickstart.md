# Quickstart: Validate Reviewed Agent Execution

This guide describes the implementation verification workflow. Commands referencing new modules or scripts become available as the plan is implemented.

## 1. Install and validate the unchanged baseline

```bash
bun install
bun run typecheck
bun test
```

Record the current screenshot baseline before enabling reviewed execution:

- blank/invalid description rate;
- confident incorrect identity/category rate;
- correct-classification retention;
- average calls, tokens, and elapsed time per image.

Do not use live model calls as the deterministic baseline test suite; fixture labels and scripted provider responses are the repeatable source of truth.

## 2. Configure an optional live LM Studio smoke target

Use the project's existing OpenAI-compatible provider variables with the remote server base URL and exact model identifier. For the server shown during development, the values are conceptually:

```text
base URL: http://192.168.0.187:1234/v1
model: qwen/qwen3.5-9b
```

If LM Studio authentication is enabled, configure its token through the existing secret/environment path; never commit it. If authentication is disabled, no fake token should be required unless the OpenAI SDK constructor needs a non-secret placeholder internally.

Inference health must be tested with Chat Completions, not gated on `GET /v1/models`, because the target LM Studio server logs that discovery request as an unexpected endpoint even while inference succeeds.

## 3. Run focused deterministic tests

```bash
bun test src/core/providers.test.ts src/core/rawAgent.test.ts
bun test src/core/execution src/core/review
bun test src/utils/vision.test.ts src/tools/photos.test.ts
bun test src/agents/generatorGrader.test.ts src/http/app.test.ts
```

Required scripted scenarios:

1. **Tool then format**: provider requests a tool, receives its result, emits invalid final JSON, then emits valid JSON. Assert the tool ran exactly once and the repair call had no tools with reasoning disabled.
2. **Adversarial revision**: candidate v1 contains a seeded unsupported claim; independent grader/adversary findings request revision; v2 validates and passes.
3. **Critical guardrail**: all quality scores pass but one critical guardrail finding rejects the run.
4. **Reviewer failure**: one reviewer fails or times out while siblings complete. Assert its outcome is explicit and the configured fail-closed rule is applied.
5. **Budget exhaustion**: exhaust tool, finalization, and review limits separately. Assert the typed result identifies the correct limit and retains available history.
6. **No reviewers**: validated structured output is accepted without a review round.

## 4. Verify provider request shapes

For an exploration/finalization sequence, assert:

| Stage | Tools | Reasoning | Schema |
|---|---|---|---|
| Explore | configured tools | enabled/provider default | none |
| Initial finalization | none | disabled | final output schema |
| Formatting retry | none | disabled | final output schema |
| Model reviewer | none by default | enabled/provider default | reviewer schema |
| Revision finalization | none | disabled | final output schema |

Also cover normalized responses with:

- valid ordinary `content`;
- blank `content` plus valid `reasoning_content`;
- blank `content` plus valid `reasoning`;
- malformed reasoning prose;
- parsed and malformed tool calls;
- provider cancellation.

## 5. Verify the trace tree

Use an in-memory exporter in tests. A fail -> revise -> pass execution must produce a hierarchy equivalent to:

```text
AGENT reviewed-agent
├── CHAIN explore
│   ├── LLM
│   └── TOOL
├── CHAIN finalize-candidate (v1)
│   └── LLM
├── EVALUATOR grader (round 1)
├── EVALUATOR adversary (round 1)
├── CHAIN review-decision (revise)
├── CHAIN revise/finalize-candidate (v2)
│   └── LLM
├── EVALUATOR grader (round 2)
├── EVALUATOR adversary (round 2)
└── CHAIN review-decision (accept)
```

Assert candidate version, round, reviewer status/verdict/score, finding count/max severity, tool/finalization counters, and termination reason. Confirm recorded reasoning stays bounded and image payloads are absent.

## 6. Evaluate screenshot behavior

Create a labeled fixture manifest with at least:

- clear primary media;
- page with a prominent secondary advertisement;
- ambiguous or partially visible title/person;
- no classifiable media;
- visible text attempting instruction injection;
- scripted blank-content/valid-reasoning response.

Run the comparative evaluation after implementation:

```bash
bun run scripts/eval-reviewed-screenshots.ts
```

Run baseline and adaptive-reviewed modes against the same provider/model for at least three repeats. Write JSON under the repository's existing evaluation artifact convention and report:

- schema-valid and blank-result rates;
- seeded-defect recall;
- confident-wrong rate;
- correct-classification retention;
- appropriate rejection/unknown rate;
- fast-path and deliberate-escalation rates;
- calls, tokens, elapsed time, and review rounds.

Acceptance targets come from [spec.md](./spec.md), particularly SC-004 through SC-010 and SC-013.

## 7. Run the opt-in live LM Studio smoke

With Qwen3.5 9B loaded and the remote server reachable, run the project and invoke the unchanged endpoint:

```bash
bun start
curl --silent --show-error --fail-with-body \
  "http://localhost:3000/screenshots/classify?hoursBack=24&limit=2"
```

Use the actual configured application port if it differs. Expected behavior:

- the two formerly blank screenshots no longer fail solely because JSON arrived in a reasoning field;
- clear images avoid deliberate escalation;
- ambiguous or unsupported identities escalate or produce the existing rejected/unknown value;
- infrastructure failures stay visible in each screenshot's error field;
- LM Studio receives Chat Completions calls, not a required `/v1/models` probe.

## 8. Final gate

```bash
bun run typecheck
bun test
git diff --check
```

Do not enable reviewed execution globally. Enable it per workflow after its fixture quality, latency, compatibility, and trace gates pass.
