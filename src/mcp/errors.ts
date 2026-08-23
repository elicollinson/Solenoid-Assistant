export function isMcpAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: number })?.code;
  return (
    code === 401 ||
    message.includes("401") ||
    message.toLowerCase().includes("unauthorized") ||
    message.includes("invalid_token") ||
    message.includes("Invalid access token")
  );
}
