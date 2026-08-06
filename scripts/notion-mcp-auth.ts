// Notion MCP OAuth authorization flow (CLI).
//
//   bun run scripts/notion-mcp-auth.ts
//
// Steps:
//   1. Discover OAuth metadata (RFC 9470 → RFC 8414)
//   2. Register a client dynamically (RFC 7591)
//   3. Generate PKCE verifier + challenge, generate state
//   4. Persist client credentials + codeVerifier + state to .env
//   5. Start a local HTTP server on port 3001 to receive the callback
//   6. Open the authorization URL in the default browser
//   7. Receive the callback, validate state, exchange code for tokens
//   8. Persist access_token + refresh_token to .env
//
// All secrets are written to .env (already gitignored).

import { log } from "../src/core/logger";
import {
  NotionMcpClient,
  setEnvValue,
  generateCodeVerifier,
  generateState,
  validateCallback,
  DEFAULT_REDIRECT_URI,
  DEFAULT_REDIRECT_PORT,
  type TokenResponse,
  type ClientCredentials,
} from "../src/mcp/notionClient";

// ---------------------------------------------------------------------------
// Main auth flow
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const redirectUri = process.env.NOTION_MCP_REDIRECT_URI || DEFAULT_REDIRECT_URI;
  const port = Number(new URL(redirectUri).port) || DEFAULT_REDIRECT_PORT;

  log.info("Starting Notion MCP OAuth flow", { redirectUri });

  const client = new NotionMcpClient();

  // Step 1-2: Discover metadata + register client
  log.info("Discovering OAuth metadata...");
  await client.initialize();

  log.info("Registering client dynamically...");
  let credentials: ClientCredentials;
  try {
    credentials = await client.register(redirectUri);
  } catch (err) {
    log.error("Client registration failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
  log.info("Client registered", { clientId: credentials.client_id });

  // Persist client credentials to .env
  setEnvValue("NOTION_MCP_CLIENT_ID", credentials.client_id);
  if (credentials.client_secret) {
    setEnvValue("NOTION_MCP_CLIENT_SECRET", credentials.client_secret);
  }
  setEnvValue("NOTION_MCP_REDIRECT_URI", redirectUri);

  // Step 3: Generate PKCE + state
  const codeVerifier = generateCodeVerifier();
  const state = generateState();

  // Persist codeVerifier + state to .env (needed for token exchange)
  setEnvValue("NOTION_MCP_CODE_VERIFIER", codeVerifier);
  setEnvValue("NOTION_MCP_STATE", state);

  // Step 4: Build authorization URL
  const authUrl = client.buildAuthUrl(redirectUri, codeVerifier, state);

  log.info("Authorization URL generated");
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Open this URL in your browser to authorize:\n");
  console.log(`  ${authUrl}`);
  console.log("\n  Waiting for callback on " + redirectUri + " ...");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // Try to open the browser automatically
  try {
    const open = (await import("child_process")).exec;
    open(`open "${authUrl}"`);
  } catch {
    // Not macOS or exec unavailable — user can copy the URL manually
  }

  // Step 5: Start local HTTP server to receive the callback
  const code = await new Promise<string>((resolve, reject) => {
    const server = Bun.serve({
      port,
      async fetch(req) {
        const url = req.url;

        // Handle the callback
        if (url.includes("/callback")) {
          try {
            const authCode = validateCallback(url, state);
            // Success page
            const body = `<html><body><h1>✅ Authorization successful!</h1><p>You can close this tab and return to the terminal.</p></body></html>`;
            resolve(authCode);
            return new Response(body, {
              headers: { "Content-Type": "text/html" },
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            reject(new Error(msg));
            return new Response(
              `<html><body><h1>❌ Authorization failed</h1><p>${msg}</p></body></html>`,
              { status: 400, headers: { "Content-Type": "text/html" } },
            );
          }
        }

        // Root — redirect to auth URL
        return Response.redirect(authUrl, 302);
      },
    });

    // Server is cleaned up after the promise resolves (process.exit below).
    log.info(`Local callback server listening on port ${port}`);
  }).catch((err) => {
    log.error("Callback handling failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });

  log.info("Authorization code received, exchanging for tokens...");

  // Step 6: Exchange code for tokens
  let tokens: TokenResponse;
  try {
    tokens = await client.exchangeTokens(code, codeVerifier, redirectUri);
  } catch (err) {
    log.error("Token exchange failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  // Step 7: Persist tokens to .env
  setEnvValue("NOTION_MCP_ACCESS_TOKEN", tokens.access_token);
  if (tokens.refresh_token) {
    setEnvValue("NOTION_MCP_REFRESH_TOKEN", tokens.refresh_token);
  }
  if (tokens.workspace_id) {
    setEnvValue("NOTION_MCP_WORKSPACE_ID", tokens.workspace_id);
  }
  if (tokens.user_id) {
    setEnvValue("NOTION_MCP_USER_ID", tokens.user_id);
  }

  // Clean up: remove codeVerifier + state from .env (no longer needed)
  setEnvValue("NOTION_MCP_CODE_VERIFIER", "");
  setEnvValue("NOTION_MCP_STATE", "");

  log.info("OAuth flow complete! Tokens persisted to .env");
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  ✅ Notion MCP authentication successful!");
  if (tokens.workspace_id) {
    console.log(`  Workspace ID: ${tokens.workspace_id}`);
  }
  if (tokens.user_id) {
    console.log(`  User ID: ${tokens.user_id}`);
  }
  if (tokens.expires_in) {
    console.log(`  Token expires in: ${tokens.expires_in}s`);
  }
  console.log("\n  Test the connection with:");
  console.log("    bun run scripts/notion-mcp-connect.ts");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  process.exit(0);
}

main();