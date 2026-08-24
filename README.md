# Solenoid Assistant

A local Bun service for experimenting with tool-using agents and personal-assistant workflows. The current workflows cover weather/tool demos, iMessage extraction, prompt-injection classification, screenshot classification and Notion ingestion, scheduled tasks, and an OKF-backed memory store.

## Requirements

- Bun 1.3+
- An Ollama-native or OpenAI-compatible model endpoint
- macOS with Full Disk Access for the iMessage, Contacts, and Photos workflows
- `osxphotos` for screenshot workflows
- Optional Notion and Tavily credentials for their respective MCP-backed agents

## Setup

```bash
bun install
cp .env.example .env
```

Start the HTTP server and cron worker together:

```bash
bun start
```

Or run them separately:

```bash
bun run start:server
bun run start:worker
```

The server defaults to `http://localhost:3000`; OpenAPI documentation is available at `/openapi`.

## Runtime configuration

The application reads and validates runtime settings through `src/core/config.ts`.

| Variable | Default | Used by |
| --- | --- | --- |
| `PORT` | `3000` | HTTP server |
| `LLM_PROVIDER` | `ollama` | Selects `ollama` or `openai` for all model calls |
| `MODEL` | `glm-5.2` | Text agents |
| `IMAGE_MODEL` | `MODEL` | Screenshot vision calls |
| `OLLAMA_API_URL` | `https://ollama.com` | Ollama client |
| `OLLAMA_API_KEY` | unset | Ollama Cloud authentication |
| `OPENAI_BASE_URL` | unset | OpenAI-compatible endpoint, such as LM Studio `/v1` |
| `OPENAI_API_KEY` | `lm-studio` fallback | OpenAI-compatible authentication |
| `STRUCTURED_OUTPUT_STRATEGY` | backend-dependent | Override `native` or `two-stage` schema completion |
| `PHOENIX_TRACING_ENABLED` | `true` | Trace export |
| `PHOENIX_COLLECTOR_ENDPOINT` | `http://localhost:6006` | Phoenix collector |
| `PHOENIX_PROJECT_NAME` | `solenoid-assistant` | Phoenix project |
| `TAVILY_API_KEY` | unset | Search-backed agents |
| `NOTION_API_TOKEN` | unset | Deterministic Notion REST search |
| `NOTION_MCP_*` | unset | Notion OAuth/MCP connection |
| `NOTION_DS_*` | unset | Recommendation target databases |

See `.env.example` for the complete list.

For the remote LM Studio model shown in the project setup, use:

```dotenv
LLM_PROVIDER=openai
OPENAI_BASE_URL=http://192.168.0.187:1234/v1
OPENAI_API_KEY=<LM Studio API token>
MODEL=qwen/qwen3.5-9b
IMAGE_MODEL=qwen/qwen3.5-9b
```

The application uses LM Studio's OpenAI-compatible `/v1/chat/completions`
endpoint so agent tool calls, multi-turn tool results, structured JSON output,
and vision requests share the existing provider implementation. When LM Studio
has **Require Authentication** enabled, generate a token in Server Settings and
set it as `OPENAI_API_KEY`; `lm-studio` is only a placeholder for servers with
authentication disabled.

Agent runs have a fifteen-minute deadline by default. LM Studio and local Ollama
use native reasoning plus schema submission in one run. Ollama Cloud defaults
to a two-stage path: an unconstrained reasoning/tool pass followed by a
reasoning-disabled schema serialization pass. Set `STRUCTURED_OUTPUT_STRATEGY`
only when a compatible backend needs an explicit override.

## HTTP endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Health check |
| POST | `/agent` | Weather demo through the generator-grader agent |
| POST | `/content-card` | Source a media content card with Tavily |
| GET | `/screenshots` | List recent local screenshots |
| GET | `/screenshots/describe` | Describe screenshots with a vision model |
| GET | `/screenshots/classify` | Classify described screenshots |
| GET | `/screenshots/ingest` | Run the existing screenshot-to-Notion ingestion workflow |
| GET | `/message-extraction` | Extract actions, summaries, and memory from trusted iMessages |
| POST | `/safety-classifier` | Score text for prompt-injection risk |
| GET | `/tasks` | List registered tasks and schedules |
| POST | `/tasks/:name/run` | Run a task manually |

The original `/messageExtraction` and `/safetyClassifier` paths remain as deprecated compatibility aliases.

## Code organization

```text
src/
  agents/       Agent primitives, factories, and lifecycle resources
  core/         Runtime config, providers, tools, logging, and tracing
  http/routes/  Elysia route modules and transport schemas
  workflows/    Multi-step application workflows used by routes
  mcp/          MCP adapters and connection lifecycle
  notion/       Notion REST integration and search tool
  contacts/     Contacts normalization and trust gate
  imessage/     Read-only Messages database access
  okf/          OKF parser, validator, and store
  tasks/        Task definitions, registry, config, and validation
  tools/        Local AgentTool definitions
  utils/        Focused supporting utilities
  index.ts      HTTP app composition; does not open a listener
  server.ts     Server startup and shutdown
  worker.ts     Cron worker startup and shutdown
```

Agent modules use the same runtime configuration and return a common lifecycle resource when they own external connections. Base agents can optionally register reviewer components; the existing weather and iMessage flows opt into generate/grade/revise by configuring the rubric grader directly.

## Notion authentication

```bash
bun run auth:notion
bun run connect:notion
```

Find or verify recommendation database IDs with:

```bash
bun run scripts/notion-find-databases.ts
bun run scripts/notion-check-databases.ts [database-id ...]
```

## Scheduled tasks

Task implementations are registered in `src/tasks/index.ts`; schedules and arguments live in `tasks.yaml`. The worker validates task names, arguments, cron expressions, and timezones before scheduling anything.

## Observability

Agent, LLM, tool, evaluator, and task spans are exported to Phoenix. Start the local collector with:

```bash
docker compose up -d
```

Then open `http://localhost:6006` and select the configured project.

## Validation

```bash
bun run typecheck
bun test
```

Live macOS and integration checks are intentionally separate from the unit suite:

```bash
bun run smoke:imessage
bun run connect:tavily
bun run connect:notion
```
