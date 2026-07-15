# manual-personal-assistant

A tiny local HTTP service built with Bun and the [`@ax-llm/ax`](https://github.com/ax-llm/ax) DSPy framework. It exposes one ax-powered endpoint (sentiment classification) and a health check.

## Requirements

- [Bun](https://bun.sh) (v1.3+)
- An LLM endpoint. Defaults to a local [Ollama](https://ollama.com) server; real OpenAI also works.

## Install

```bash
bun install
```

## Run

```bash
bun start
```

Listens on `http://localhost:3000` (override with `PORT=...`).

### Configuring the LLM

Environment variables (read at startup):

| Var | Default | Notes |
| --- | --- | --- |
| `OPENAI_APIKEY` | `ollama` | API key; ignored by Ollama |
| `OPENAI_API_URL` | `http://localhost:11434/v1` | any OpenAI-compatible endpoint |
| `MODEL` | `gpt-4o-mini` | model name the endpoint serves |

Examples:

```bash
bun start                                          # local Ollama, default model
MODEL="qwen3:8b" bun start                          # pick an installed Ollama model
OPENAI_APIKEY=sk-... bun start                      # real OpenAI
OPENAI_APIKEY=sk-... OPENAI_API_URL=https://api.openai.com/v1 bun start
```

### Agent providers

The `Agent` class (`src/utils/raw_agent.ts`) runs on Ollama by default but also supports OpenAI and Anthropic through adapters in `src/utils/providers.ts`. Tools defined with `defineTool` work unchanged across all three.

**Ollama (default)** — pass the client directly, as in `src/agents/demo.ts`:

```ts
import { Ollama } from "ollama";
import { Agent } from "./utils/raw_agent";

const agent = new Agent({
  client: new Ollama({ host: "http://localhost:11434" }),
  model: "qwen3:8b",
  tools: [...],
});
```

**OpenAI** — set `OPENAI_API_KEY` in your environment, then wrap the client:

```ts
import OpenAI from "openai";
import { OpenAIProvider } from "./utils/providers";

const agent = new Agent({
  client: new OpenAIProvider(new OpenAI()),
  model: "gpt-5.2",
  tools: [...],
});
```

**Anthropic** — set `ANTHROPIC_API_KEY` in your environment, then wrap the client:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicProvider } from "./utils/providers";

const agent = new Agent({
  client: new AnthropicProvider(new Anthropic()),
  model: "claude-opus-4-8",
  tools: [...],
});
```

Both SDKs read their API key from the environment automatically — no key needs to be passed in code. The `think` option maps to each provider's reasoning controls (Ollama `think`, OpenAI `reasoning_effort`, Anthropic adaptive thinking + effort).

## Endpoints

### `GET /health`

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

### `POST /agent`

Classifies a review's sentiment using an ax signature.

```bash
curl -X POST http://localhost:3000/agent \
  -H 'Content-Type: application/json' \
  -d '{"review":"This product is amazing!"}'
# {"review":"This product is amazing!","sentiment":"positive"}
```

- `400` on missing/invalid JSON or no `review` field
- `502` if the LLM call fails (error message returned in the body)

## Project layout

```
src/
  index.ts   service entry: boots Bun.serve, dispatches routes
  health.ts  GET /health
  agent.ts   POST /agent — ax sentiment classifier + LLM client
```

The ax demo (signature + provider config) is isolated in `src/agent.ts`; `src/index.ts` only imports handlers and routes requests.

## Type-check

```bash
bun run typecheck
```
## Observability (Phoenix tracing)

Every `agent.run()` invocation produces one trace in [Arize Phoenix](https://docs.arize.com/phoenix): an AGENT root span, an LLM span per model call (with messages, token counts, and tool schemas), and a TOOL span per tool call. Log lines written with `log` from `src/core/logger.ts` inside tool logic appear as events on the tool's span. Tracing is built into the base classes (`Agent`, `BaseChatProvider`), so new agents, tools, and providers are traced automatically.

```bash
# Start local Phoenix (data persists on the host in ./phoenix_data)
docker compose up -d

# Run the service and make a request, then open the UI
open http://localhost:6006   # project: solenoid-assistant
```

Configuration (see `.env.example`): `PHOENIX_COLLECTOR_ENDPOINT`, `PHOENIX_PROJECT_NAME`, and `PHOENIX_TRACING_ENABLED=false` to disable tracing entirely.
