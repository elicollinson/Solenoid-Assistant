// Notion MCP client — OAuth 2.0 Authorization Code flow with PKCE, plus
// Streamable HTTP / SSE transport. Follows the guide at
// https://developers.notion.com/guides/mcp/build-mcp-client.
//
// CLI-oriented: credentials are persisted in .env (codeVerifier, client_id,
// client_secret, access_token, refresh_token). The auth script starts a local
// HTTP server to receive the OAuth callback; the connect script reads tokens
// from .env and talks to the MCP server.

import { randomBytes, createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { log } from "../core/logger";

// ---------------------------------------------------------------------------
// Types (Zod schemas → inferred types)
// ---------------------------------------------------------------------------

/** Zod schema for OAuth 2.0 authorization server metadata (RFC 8414). */
export const oauthMetadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string().optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  grant_types_supported: z.array(z.string()).optional(),
  response_types_supported: z.array(z.string()).optional(),
  scopes_supported: z.array(z.string()).optional(),
});

export type OAuthMetadata = z.infer<typeof oauthMetadataSchema>;

/** Zod schema for the protected resource metadata (RFC 9470) — only the fields we read. */
const protectedResourceSchema = z.object({
  authorization_servers: z.array(z.string()).optional(),
});

/** Zod schema for dynamic client registration credentials (RFC 7591). */
export const clientCredentialsSchema = z.object({
  client_id: z.string(),
  client_secret: z.string().optional(),
  client_id_issued_at: z.number().optional(),
  client_secret_expires_at: z.number().optional(),
});

export type ClientCredentials = z.infer<typeof clientCredentialsSchema>;

/** Zod schema for an OAuth token response (authorization-code or refresh). */
export const tokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  // Identity fields, present on successful authorization-code exchanges
  user_id: z.string().optional(),
  workspace_id: z.string().optional(),
  email_domain: z.string().optional(),
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;

/** Zod schema for an OAuth error response body. */
const tokenErrorResponseSchema = z.object({
  error: z.string().optional(),
});

const clientRegistrationSchema = z.object({
  client_name: z.string(),
  client_uri: z.string().optional(),
  redirect_uris: z.array(z.string()),
  grant_types: z.array(z.string()),
  response_types: z.array(z.string()),
  token_endpoint_auth_method: z.string(),
  scope: z.string().optional(),
});

type ClientRegistration = z.infer<typeof clientRegistrationSchema>;

const callbackParamsSchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

type CallbackParams = z.infer<typeof callbackParamsSchema>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const NOTION_MCP_SERVER_URL = "https://mcp.notion.com";

// Default redirect URI for the local callback server.
export const DEFAULT_REDIRECT_PORT = 3001;
export const DEFAULT_REDIRECT_URI = `http://localhost:${DEFAULT_REDIRECT_PORT}/callback`;

// Path to .env relative to cwd. Bun loads .env into process.env at startup;
// this is used for *persisting* rotated tokens back to disk so the next
// process start doesn't need a full re-auth.
const ENV_PATH = ".env";

/**
 * Set or update a key=value pair in the .env file (preserves other lines).
 * Used to persist rotated OAuth tokens so the next process start doesn't
 * need a full re-auth flow.
 */
export function setEnvValue(key: string, value: string): void {
  if (!existsSync(ENV_PATH)) {
    writeFileSync(ENV_PATH, `${key}=${value}\n`);
    return;
  }
  const lines = readFileSync(ENV_PATH, "utf-8").split("\n");
  const prefix = `${key}=`;
  let found = false;
  const updated = lines.map((line) => {
    if (line.startsWith(prefix)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) {
    updated.push(`${key}=${value}`);
  }
  writeFileSync(ENV_PATH, updated.join("\n"));
}

// ---------------------------------------------------------------------------
// Step 1: OAuth discovery (RFC 9470 → RFC 8414)
// ---------------------------------------------------------------------------

/**
 * Discovers OAuth configuration for an MCP server using RFC 9470 + RFC 8414.
 */
export async function discoverOAuthMetadata(
  mcpServerUrl: string,
): Promise<OAuthMetadata> {
  const url = new URL(mcpServerUrl);
  const protectedResourceUrl = new URL(
    "/.well-known/oauth-protected-resource",
    url,
  );

  // Step 1: RFC 9470 - Get Protected Resource Metadata
  const protectedResourceResponse = await fetch(
    protectedResourceUrl.toString(),
  );
  if (!protectedResourceResponse.ok) {
    throw new Error(
      `Failed to fetch protected resource metadata: ${protectedResourceResponse.status}`,
    );
  }

  const protectedResourceRaw = await protectedResourceResponse.json();
  const protectedResourceParsed = protectedResourceSchema.safeParse(protectedResourceRaw);
  if (!protectedResourceParsed.success) {
    throw new Error(
      `Malformed protected resource metadata: ${protectedResourceParsed.error.message}`,
    );
  }
  const authServers = protectedResourceParsed.data.authorization_servers;

  if (!Array.isArray(authServers) || authServers.length === 0) {
    throw new Error(
      "No authorization servers found in protected resource metadata",
    );
  }

  // Use the first authorization server
  const authServerUrl = authServers[0]!;

  // Step 2: RFC 8414 - Get Authorization Server Metadata
  const metadataUrl = new URL(
    "/.well-known/oauth-authorization-server",
    authServerUrl,
  );
  const metadataResponse = await fetch(metadataUrl.toString());

  if (!metadataResponse.ok) {
    throw new Error(
      `Failed to fetch authorization server metadata: ${metadataResponse.status}`,
    );
  }

  const metadataRaw = await metadataResponse.json();
  const metadataParsed = oauthMetadataSchema.safeParse(metadataRaw);
  if (!metadataParsed.success) {
    throw new Error(
      `Malformed authorization server metadata: ${metadataParsed.error.message}`,
    );
  }

  const metadata = metadataParsed.data;

  // Validate required fields (already enforced by the schema, but keep the
  // explicit check for the same clear error message the original code had).
  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new Error("Missing required OAuth endpoints in metadata");
  }

  // Warn if PKCE support isn't advertised
  if (!metadata.code_challenge_methods_supported?.includes("S256")) {
    log.warn(
      "Server does not advertise S256 PKCE support, but we will use it anyway",
    );
  }

  return metadata;
}

// ---------------------------------------------------------------------------
// Step 2: PKCE parameters
// ---------------------------------------------------------------------------

function base64URLEncode(str: Buffer): string {
  return str
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export function generateCodeVerifier(): string {
  // Generate 32 random bytes = 256 bits.
  // Base64 encoding produces ~43 characters.
  const bytes = randomBytes(32);
  return base64URLEncode(bytes);
}

export function generateCodeChallenge(verifier: string): string {
  const hash = createHash("sha256").update(verifier).digest();
  return base64URLEncode(hash);
}

// ---------------------------------------------------------------------------
// Step 3: Dynamic client registration (RFC 7591)
// ---------------------------------------------------------------------------

export async function registerClient(
  metadata: OAuthMetadata,
  redirectUri: string,
): Promise<ClientCredentials> {
  if (!metadata.registration_endpoint) {
    throw new Error("Server does not support dynamic client registration");
  }

  const registrationRequest: ClientRegistration = {
    client_name: "Manual Personal Assistant MCP Client",
    client_uri: "https://github.com/eli",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };

  const response = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(registrationRequest),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Client registration failed: ${response.status} - ${errorBody}`,
    );
  }

  const credentialsRaw = await response.json();
  const credentialsParsed = clientCredentialsSchema.safeParse(credentialsRaw);
  if (!credentialsParsed.success) {
    throw new Error(
      `Client registration returned malformed credentials: ${credentialsParsed.error.message}`,
    );
  }

  return credentialsParsed.data;
}

// ---------------------------------------------------------------------------
// Step 4: Initiate authorization flow
// ---------------------------------------------------------------------------

export function buildAuthorizationUrl(
  metadata: OAuthMetadata,
  clientId: string,
  redirectUri: string,
  codeChallenge: string,
  state: string,
  scopes: string[] = [],
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(" "),
    state: state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "consent",
  });

  return `${metadata.authorization_endpoint}?${params.toString()}`;
}

export function generateState(): string {
  return randomBytes(32).toString("hex");
}

// ---------------------------------------------------------------------------
// Step 5: Handle OAuth callback
// ---------------------------------------------------------------------------

export function parseCallback(url: string): CallbackParams {
  const urlParams = new URLSearchParams(new URL(url).search);

  return {
    code: urlParams.get("code") || undefined,
    state: urlParams.get("state") || undefined,
    error: urlParams.get("error") || undefined,
    error_description: urlParams.get("error_description") || undefined,
  };
}

export function validateCallback(
  callbackUrl: string,
  storedState: string,
): string {
  const params = parseCallback(callbackUrl);

  if (params.error) {
    throw new Error(
      `OAuth error: ${params.error} - ${params.error_description || "Unknown error"}`,
    );
  }

  if (params.state !== storedState) {
    throw new Error("Invalid state parameter - possible CSRF attack");
  }

  if (!params.code) {
    throw new Error("Missing authorization code");
  }

  return params.code;
}

// ---------------------------------------------------------------------------
// Step 6: Exchange authorization code for tokens
// ---------------------------------------------------------------------------

export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  metadata: OAuthMetadata,
  clientId: string,
  clientSecret: string | undefined,
  redirectUri: string,
): Promise<TokenResponse> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  if (clientSecret) {
    params.append("client_secret", clientSecret);
  }

  const response = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "ManualPersonalAssistant-MCP-Client/1.0",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Token exchange failed: ${response.status} - ${errorBody}`);
  }

  const tokensRaw = await response.json();
  const tokensParsed = tokenResponseSchema.safeParse(tokensRaw);
  if (!tokensParsed.success) {
    throw new Error(
      `Token exchange returned malformed response: ${tokensParsed.error.message}`,
    );
  }

  return tokensParsed.data;
}

// ---------------------------------------------------------------------------
// Step 7: Connect to MCP server with authentication
// ---------------------------------------------------------------------------

export async function createMcpClient(
  serverUrl: string,
  accessToken: string,
  useSSE: boolean = false,
): Promise<Client> {
  const client = new Client(
    {
      name: "manual-personal-assistant",
      version: "1.0.0",
    },
    {
      capabilities: {
        roots: {},
        sampling: {},
      },
    },
  );

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "ManualPersonalAssistant-MCP-Client/1.0",
  };

  let transport;

  if (useSSE) {
    transport = new SSEClientTransport(new URL(`${serverUrl}/sse`), {
      requestInit: { headers },
    });
  } else {
    transport = new StreamableHTTPClientTransport(new URL(`${serverUrl}/mcp`), {
      requestInit: { headers },
    });
  }

  await client.connect(transport);

  return client;
}

// Usage with automatic fallback
export async function connectToNotionMcp(
  accessToken: string,
): Promise<Client> {
  const serverUrl = NOTION_MCP_SERVER_URL;

  try {
    return await createMcpClient(serverUrl, accessToken, false);
  } catch (error) {
    log.warn("Streamable HTTP failed, falling back to SSE", {
      error: error instanceof Error ? error.message : String(error),
    });
    return await createMcpClient(serverUrl, accessToken, true);
  }
}

// ---------------------------------------------------------------------------
// Step 8: Handle token refresh
// ---------------------------------------------------------------------------

export async function refreshAccessToken(
  refreshToken: string,
  metadata: OAuthMetadata,
  clientId: string,
  clientSecret: string | undefined,
): Promise<TokenResponse> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });

  if (clientSecret) {
    params.append("client_secret", clientSecret);
  }

  const response = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorBody = await response.text();

    try {
      const errorParsed = tokenErrorResponseSchema.safeParse(JSON.parse(errorBody));
      if (errorParsed.success) {
        if (errorParsed.data.error === "invalid_grant") {
          throw new Error("REAUTH_REQUIRED");
        }
        if (errorParsed.data.error === "invalid_client") {
          throw new Error("INVALID_CLIENT");
        }
      }
    } catch (parseError) {
      // Re-throw our own sentinel errors; swallow JSON parse failures.
      if (
        parseError instanceof Error &&
        (parseError.message === "REAUTH_REQUIRED" ||
          parseError.message === "INVALID_CLIENT")
      ) {
        throw parseError;
      }
    }

    throw new Error(`Token refresh failed: ${response.status} - ${errorBody}`);
  }

  const tokensRaw = await response.json();
  const tokensParsed = tokenResponseSchema.safeParse(tokensRaw);
  if (!tokensParsed.success) {
    throw new Error(
      `Token refresh returned malformed response: ${tokensParsed.error.message}`,
    );
  }

  return tokensParsed.data;
}

// ---------------------------------------------------------------------------
// Complete client class — ties all steps together with .env-based storage
// ---------------------------------------------------------------------------

/**
 * Reads a value from .env (already loaded by Bun into process.env) or returns
 * undefined if not set.
 */
function env(key: string): string | undefined {
  return process.env[key];
}

export class NotionMcpClient {
  private serverUrl = NOTION_MCP_SERVER_URL;
  private metadata!: OAuthMetadata;
  private clientId: string | undefined;
  private clientSecret: string | undefined;
  private accessToken: string | undefined;
  private refreshToken: string | undefined;
  private client: Client | undefined;

  /** Load metadata + credentials from .env; discover metadata if missing. */
  async initialize(): Promise<void> {
    // Try to load persisted metadata by discovering it fresh (it's cheap and
    // ensures endpoints are current). The client_id/secret and tokens come
    // from .env.
    this.metadata = await discoverOAuthMetadata(this.serverUrl);
    this.clientId = env("NOTION_MCP_CLIENT_ID");
    this.clientSecret = env("NOTION_MCP_CLIENT_SECRET") || undefined;
    this.accessToken = env("NOTION_MCP_ACCESS_TOKEN");
    this.refreshToken = env("NOTION_MCP_REFRESH_TOKEN");
  }

  /**
   * Run dynamic client registration and return the credentials.
   * The caller should persist them to .env.
   */
  async register(redirectUri: string): Promise<ClientCredentials> {
    if (!this.metadata) {
      this.metadata = await discoverOAuthMetadata(this.serverUrl);
    }
    const credentials = await registerClient(this.metadata, redirectUri);
    this.clientId = credentials.client_id;
    this.clientSecret = credentials.client_secret;
    return credentials;
  }

  /**
   * Generate the authorization URL. The codeVerifier and state are returned
   * to the caller for secure storage (in .env for this CLI setup).
   */
  buildAuthUrl(
    redirectUri: string,
    codeVerifier: string,
    state: string,
  ): string {
    if (!this.clientId) {
      throw new Error("Client not registered — call register() first");
    }
    const codeChallenge = generateCodeChallenge(codeVerifier);
    return buildAuthorizationUrl(
      this.metadata,
      this.clientId,
      redirectUri,
      codeChallenge,
      state,
    );
  }

  /**
   * Exchange the authorization code (from the callback) for tokens.
   * Requires the codeVerifier that was used to generate the challenge.
   */
  async exchangeTokens(
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<TokenResponse> {
    if (!this.clientId) {
      throw new Error("Client not registered — call register() first");
    }
    const tokens = await exchangeCodeForTokens(
      code,
      codeVerifier,
      this.metadata,
      this.clientId,
      this.clientSecret,
      redirectUri,
    );
    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token;
    return tokens;
  }

  /** Connect to the MCP server using the stored access token.
   *
   * Notion access tokens expire (~8h). If the initial connection fails with a
   * 401, this automatically refreshes the token via the stored refresh token,
   * persists the rotated tokens to `.env`, and retries. If the refresh also
   * fails (e.g. `invalid_grant`), the error propagates — the caller should
   * prompt the user to re-run the auth flow.
   */
  async connect(): Promise<Client> {
    if (!this.accessToken) {
      throw new Error("Not authenticated — run the auth flow first");
    }

    try {
      this.client = await this.tryConnect(this.accessToken);
      return this.client;
    } catch (error) {
      // If it's a 401 (expired token), try refreshing and retrying once.
      if (this.isAuthError(error)) {
        log.info("Notion access token expired — refreshing...");
        await this.ensureValidToken();
        this.persistTokens();
        log.info("Notion token refreshed and persisted to .env");
        this.client = await this.tryConnect(this.accessToken!);
        return this.client;
      }
      throw error;
    }
  }

  /** Try both transports (Streamable HTTP, then SSE fallback).
   *
   * If the Streamable HTTP error is auth-related (expired/invalid token), we
   * re-throw it immediately instead of falling back to SSE. The SSE fallback
   * would also fail (same expired token), but with a *different* error format
   * (e.g. connection refused, 404 for missing /sse endpoint) that does NOT
   * contain `invalid_token` or `401` — masking the auth error and preventing
   * the auto-refresh in `connect()` from triggering.
   */
  private async tryConnect(token: string): Promise<Client> {
    try {
      return await createMcpClient(this.serverUrl, token, false);
    } catch (error) {
      // If it's an auth error, don't bother with SSE — it will fail the same
      // way but with an unrecognisable error message. Re-throw so connect()
      // can detect it and refresh the token.
      if (this.isAuthError(error)) {
        throw error;
      }
      log.warn("Streamable HTTP failed, falling back to SSE", {
        error: error instanceof Error ? error.message : String(error),
      });
      return await createMcpClient(this.serverUrl, token, true);
    }
  }

  /** Detect whether an error is auth-related (401 / expired / invalid token).
   *
   * Notion's MCP server returns `{"error":"invalid_token","error_description":"Invalid access token"}`
   * when the access token has expired — this does NOT contain "401" or
   * "unauthorized", so we must also check for `invalid_token` and
   * `Invalid access token` to trigger the auto-refresh path.
   */
  private isAuthError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    // The MCP SDK's StreamableHTTPError and SseError both expose a `code`
    // property with the HTTP status code.
    const code = (error as { code?: number })?.code;
    return (
      code === 401 ||
      msg.includes("401") ||
      msg.includes("unauthorized") ||
      msg.includes("invalid_token") ||
      msg.includes("Invalid access token")
    );
  }

  /** Persist the current access + refresh tokens to .env for next startup. */
  private persistTokens(): void {
    if (this.accessToken) {
      setEnvValue("NOTION_MCP_ACCESS_TOKEN", this.accessToken);
    }
    if (this.refreshToken) {
      setEnvValue("NOTION_MCP_REFRESH_TOKEN", this.refreshToken);
    }
  }

  /** Refresh the access token using the stored refresh token. */
  async ensureValidToken(): Promise<TokenResponse> {
    if (!this.refreshToken) {
      throw new Error("No refresh token available");
    }
    if (!this.clientId) {
      throw new Error("Client not registered");
    }

    try {
      const tokens = await refreshAccessToken(
        this.refreshToken,
        this.metadata,
        this.clientId,
        this.clientSecret,
      );

      this.accessToken = tokens.access_token;
      if (tokens.refresh_token) {
        this.refreshToken = tokens.refresh_token;
      }
      return tokens;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "REAUTH_REQUIRED"
      ) {
        throw new Error("Re-authentication required");
      }
      throw error;
    }
  }

  get isConnected(): boolean {
    return this.client !== undefined;
  }

  get hasCredentials(): boolean {
    return this.clientId !== undefined;
  }

  get hasTokens(): boolean {
    return this.accessToken !== undefined;
  }
}