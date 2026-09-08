export function sourceEndpoint() {
  const value = process.env.SOURCE_REMOTE_URL;
  if (!value) throw new Error("SOURCE_REMOTE_URL is required");
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    )
  )
    throw new Error("Source transport requires HTTPS");
  return url;
}
export async function sourceRequest(
  route: string,
  token: string,
  body?: string | FormData,
  headers: Record<string, string> = {},
) {
  if (token.length < 32)
    throw new Error("Source token must have at least 32 characters");
  const response = await fetch(new URL(route, sourceEndpoint()), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, ...headers },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok)
    throw new Error(
      `Source request ${route.split("?")[0]} failed (${response.status})`,
    );
  return response;
}
