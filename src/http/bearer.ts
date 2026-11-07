import { timingSafeEqual } from "node:crypto";

/**
 * Whether the request carries `Authorization: Bearer <token>`.
 *
 * An unset or short token refuses everything rather than accepting anything,
 * so a missing secret closes a machine-facing route instead of opening it.
 */
export function bearerAuthorized(request: Request, token: string | undefined): boolean {
  const supplied = request.headers.get("authorization") ?? "";
  if (!token || token.length < 32) return false;
  const expected = Buffer.from(`Bearer ${token}`),
    actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
