export function isMcpAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown })?.code;
  return (
    code === 401 ||
    code === "NOTION_AUTHENTICATION_REQUIRED" ||
    message.includes("401") ||
    message.toLowerCase().includes("unauthorized") ||
    message.includes("invalid_token") ||
    message.includes("Invalid access token") ||
    message === "Re-authentication required"
  );
}

export class NotionAuthenticationRequiredError extends Error {
  readonly code = "NOTION_AUTHENTICATION_REQUIRED";

  constructor(readonly reason: "missing_credentials" | "refresh_rejected" | "invalid_client") {
    super("Notion authentication required; run `bun run auth:notion`, then restart the service.");
    this.name = "NotionAuthenticationRequiredError";
  }
}

export function isNotionAuthenticationRequiredError(
  error: unknown,
): error is NotionAuthenticationRequiredError {
  return (error as { code?: unknown } | null)?.code === "NOTION_AUTHENTICATION_REQUIRED";
}
