// Handle normalization shared by the Contacts loader and the Messages side
// (spec §5). Both MUST key through these functions or the trust gate
// silently drops known contacts.

/**
 * Normalize free-form human phone input to an E.164-shaped key (§5.1).
 * Returns null for <7 digits (short codes — untrusted by definition).
 */
export function normalizePhone(raw: string, defaultCountryCode = "1"): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+${defaultCountryCode}${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 7 && digits.length <= 15) return `+${digits}`;
  return null;
}

/** iMessage email handles are already lowercase; Contacts may not be (§5.2). */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Secondary lookup key for country-code mismatches (§5.3). Only defined for
 * handles with >=10 digits — short codes never get a secondary key.
 */
export function lastTenDigits(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}
