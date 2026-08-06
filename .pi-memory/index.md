# Subdirectories

* [agents](agents/index.md) - Agent that inserts or updates a single record in a Notion gallery database (books, movies, TV, music, games) using filtered Notion MCP tools (search, create-pages, update-page).
* [debugsolutions](debugsolutions/index.md) - Two-layer bug: (1) isAuthError() didn't detect \"invalid_token\" / \"Invalid access token\", and (2) the SSE fallback in tryConnect() masked the auth error with a non-auth SSE error, preventing connect() from ever seeing the original auth error.
* [endpoints](endpoints/index.md) - GET /screenshots/ingest endpoint that classifies screenshots, sources content cards via Tavily MCP for non-rejected items, and ingests them into Notion via the recommendation ingestion agent.
* [integrations](integrations/index.md)
