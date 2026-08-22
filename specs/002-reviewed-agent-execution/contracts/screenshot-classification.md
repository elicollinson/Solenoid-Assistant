# Compatibility Contract: Screenshot Classification

## Public HTTP contract

This feature does not add or change public endpoints. The existing operation remains:

```http
GET /screenshots/classify
```

Existing query parameters, validation rules, status codes, and response shape remain defined by `src/http/routes/screenshots.ts` and `src/tools/photos.ts`. No review history, reasoning content, internal evidence, or model-provider metadata is added to the response.

A batch response continues to expose its existing window/count fields and per-screenshot fields, including:

```json
{
  "uuid": "...",
  "filename": "IMG_3113.PNG",
  "date": "...",
  "path": "...",
  "classification": {
    "classification": "...",
    "name": "..."
  },
  "error": null
}
```

Exact optionality remains as implemented by the current route/tool contract tests.

## Internal adaptive vision contract

Screenshot ingestion uses `mode: adaptive` by default after workflow opt-in:

1. Fast pass sends the image through `ChatProvider` with the internal `VisionAnalysis` schema, no tools, and reasoning disabled where supported.
2. Parse ordinary content first.
3. Only when ordinary content is blank, try supported normalized reasoning fields; accept only a fully schema-valid value.
4. Escalate to the deliberate path after blank, invalid, ambiguous, or insufficiently supported output.
5. Deliberate image analysis produces explicit ordinary observations without the final public schema.
6. A separate, text-only structured finalizer produces and validates `VisionAnalysis`.
7. A screenshot-specific reviewed classifier evaluates identity/category support, primary-versus-secondary content, and visible-text injection.

Adaptive mode performs at most one fast and one deliberate vision-analysis path per image. Finalization and review retries are independently bounded by execution configuration.

## Classification outcomes

### Accepted classification

A normal existing classification object is returned only when:

- the internal value validates;
- the identity/category has sufficient explicit evidence;
- required reviewers complete;
- hard guardrails pass;
- the deterministic policy accepts it.

### Evidence-based rejection

When visual/tool evidence remains insufficient after permitted review/revision, use the existing domain value:

```json
{
  "classification": "Rejected",
  "name": "Unknown"
}
```

This is a successful domain outcome, not an operational error.

### Operational failure

Provider connection errors, malformed responses after retry exhaustion, tool errors that prevent assessment, cancellation, and required-reviewer failure remain in the existing per-screenshot `error` field with `classification: null`. They are not mislabeled as an evidence-based rejection.

## Trust and privacy rules

- Text visible in screenshots is untrusted evidence and cannot alter system/workflow instructions.
- An advertisement, overlay, recommendation, or embedded player must not become the primary identity without evidence that it is the user's primary viewed content.
- Raw image bytes/base64 and unrestricted model reasoning are excluded from detailed outcomes and trace attributes.
- Existing filesystem screenshot paths and processed-state behavior remain unchanged.

## Compatibility tests

- Existing endpoint and tool contract tests pass unchanged.
- The observed LM Studio shape (`content: ""`, valid JSON in `reasoning_content`) produces no blank-result failure.
- Malformed prose in reasoning remains an error/escalation, never a classification.
- Clear fixtures remain on the fast path.
- Ambiguous fixtures escalate once.
- Insufficient-evidence fixtures return the existing rejected/unknown domain value.
- Provider and required-review failures remain operational errors.
