# One-off workflows from chat

Chat discovers workflows through the existing `workflows` tool group. A request
such as “Run the Lisbon weather briefing, focusing on walking weather” follows
this contract:

1. Open `get_workflows_tools`, then `workflows_list({runnable:true})`. Rows include
   purpose, inputs, runnable/paused state, and schedule information.
2. Read the selected slug with `workflows_read`. Its `inputs` include descriptions,
   defaults and required fields; `argumentSchema` describes the registry's Zod
   input schema, including nested objects. Zod preprocessors cannot be fully
   expressed as JSON Schema, so their JSON representation may be unconstrained.
   The runner always validates using the original schema.
3. Call `workflows_run` with structured arguments and optional free-text guidance:

   ```json
   {
     "slug": "weather-briefing",
     "args": {"city": "Lisbon"},
     "guidance": "Focus on walking weather"
   }
   ```

   This is a **write tool**, subject to the chat's existing approval UI and absent
   from read-only tool groups. Required structured inputs must be supplied;
   guidance does not replace them. The tool never resumes a paused workflow.
4. A successful start returns `{slug, runId, ordinal, state, error}`. It starts
   background work and does not wait for completion. Report the returned state;
   do not claim completion or repeat the start call to poll. Read
   `workflows_read_run({runId})` for the actual state, error, output and prose.
   Output uses the same serialized representation as the Workflows output pane.
   `workflows_read_runs` and `workflows_read_run_logs` remain available for history
   and diagnosis. Unknown, unimplemented, paused, and invalid-argument starts fail
   before a run is created; later failures are recorded on the run.

## Shared execution contract

All invocation paths use the existing registry and runner. There is no chat
switch statement or per-workflow dispatch map:

```ts
startWorkflowRun(db, slug, args, {
  guidance: "Optional focus for this execution",
  trigger: "manual",
  source: { kind: "chat", conversationId },
});
```

`StartOptions.guidance` is optional, trimmed, and limited to 16,000 characters.
Blank guidance behaves like omission. The source is supplied by application code,
not as a model-controlled tool argument. Chat starts remain manual/user runs;
the initial run log identifies chat as the source and stores a JSON invocation
record containing validated args, guidance and source/conversation id. That record
exists before workflow execution and remains reviewable after cancellation or
failure. No migration or saved schedule/instruction mutation is involved.

`RunnableWorkflow.execute(args, context)` receives `context.signal`, the run database as
`context.db`, and optional `context.guidance`. The runner also enters an async-local guidance scope. Every
ordinary `Agent.run`, `Agent.runWithSignal`, and `Agent.runMessages` invocation
inside that scope receives guidance automatically before screening and its first
model call, including nested agents, fan-out branches, singleton agents and model
fallback attempts. Do not append it again at each workflow or agent call site.

Guidance is a separate **user-role** message with operator provenance. A fixed
system instruction restricts it to the assigned task and preserves governing
instructions, task rules, schemas, safety checks and permissions. Existing prompts
remain unchanged. External task data keeps its original screening provenance.
Saved standing instructions are neither rewritten nor newly interpreted by this
feature; their existing execution behavior is unchanged.

Concurrent runs have separate scopes. A later run with no guidance receives none,
even when started from within another run. The initiating chat's approval and
stream callbacks are detached from background execution. The workflow's normal
permission gate governs nested writes (`allow`, `deny`, or a durable deferred
`ask`), independently of approval to start the workflow.

The runner retains its existing cancellation and concurrency rules. Manual runs
may overlap; the scheduler still skips a workflow with a run in flight. Cancel
raises `context.signal` and prevents late results from overwriting the cancelled
record; workflow code must continue passing the signal to abortable operations.

## Adding a workflow

Add its ordinary catalog and registry entries and sync the catalog. Supply its
input descriptions and Zod schema as usual. Agents called through the shared
`Agent` API inherit guidance without further integration. A workflow using direct
provider calls, a separate process, or a remote worker must explicitly propagate
`context.guidance` using equivalent user-message priority and rules. Async-local
state does not cross process boundaries. Guidance can refine a workflow's focus,
but mandatory coverage and other governing requirements remain in force.

## Verification

`src/workflows/chatExecution.test.ts` exercises discovery and dispatch for all
existing schemas and a future nested schema, real chat approval through the
weather registry and shared Agent using scripted providers, denied/invalid starts,
run/result tracking, cancellation, nested singleton agents, concurrent and later
scheduled-run isolation, and workflow deny/ask permissions. It also runs the real log-monitoring registry
and dedicated Agent with fixture logs, verifying broad coverage, incomplete-review
checkpoint retention, retry completion, guidance isolation, and message-date coercion.
`src/core/runGuidance.test.ts` verifies input provenance, model fallback and nested
scope restoration. Tests perform no external model requests or external writes.
