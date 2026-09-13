import type { JWTInput } from "google-auth-library";

type Env = Record<string, string | undefined>;
export type GoogleCredentialOptions = { credentialsJson?: string; credentialsBase64?: string };
type InlineSource = "MODEL_ARMOR_CREDENTIALS_JSON" | "GOOGLE_APPLICATION_CREDENTIALS_JSON" |
  "MODEL_ARMOR_CREDENTIALS_BASE64" | "GOOGLE_APPLICATION_CREDENTIALS_BASE64";

// Preserve Model Armor's existing JSON-before-base64 precedence. Explicit scanner
// options stand in for MODEL_ARMOR_* values; both consumers share the same order.
function select(options: GoogleCredentialOptions, env: Env): { source: InlineSource; value: string } | undefined {
  const candidates: [InlineSource, string | undefined][] = [
    ["MODEL_ARMOR_CREDENTIALS_JSON", options.credentialsJson || env.MODEL_ARMOR_CREDENTIALS_JSON],
    ["GOOGLE_APPLICATION_CREDENTIALS_JSON", env.GOOGLE_APPLICATION_CREDENTIALS_JSON],
    ["MODEL_ARMOR_CREDENTIALS_BASE64", options.credentialsBase64 || env.MODEL_ARMOR_CREDENTIALS_BASE64],
    ["GOOGLE_APPLICATION_CREDENTIALS_BASE64", env.GOOGLE_APPLICATION_CREDENTIALS_BASE64],
  ];
  for (const [source, value] of candidates) if (value?.trim()) return { source, value: value.trim() };
}

/** Safe for configuration diagnostics: returns only a variable name, never its value. */
export function googleCredentialSource(options: GoogleCredentialOptions = {}, env: Env = process.env): InlineSource | "adc" {
  return select(options, env)?.source ?? "adc";
}

export class GoogleCredentialsError extends Error {
  constructor(readonly source: InlineSource) {
    // Do not retain a JSON parser cause: its message can contain secret material.
    super(`Invalid Google credentials in ${source}; expected a credential JSON object${source.endsWith("BASE64") ? " encoded as base64" : ""}.`);
    this.name = "GoogleCredentialsError";
  }
}

/** Call only when auth is needed. Undefined leaves standard ADC resolution to Google. */
export function loadGoogleCredentials(options: GoogleCredentialOptions = {}, env: Env = process.env): JWTInput | undefined {
  const chosen = select(options, env);
  if (!chosen) return undefined;
  try {
    let json = chosen.value;
    if (chosen.source.endsWith("BASE64")) {
      const encoded = json.replace(/\s/g, "");
      const bytes = Buffer.from(encoded, "base64");
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
        throw new Error("Invalid base64");
      }
      json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    const credentials: unknown = JSON.parse(json);
    if (!credentials || typeof credentials !== "object" || Array.isArray(credentials) ||
        !("type" in credentials) || typeof credentials.type !== "string" || !credentials.type.trim()) {
      throw new Error("Expected a typed credential object");
    }
    // Google validates the fields for the selected credential type, including
    // service accounts, user ADC, and federated credentials. Do not narrow here.
    return credentials as JWTInput;
  } catch { throw new GoogleCredentialsError(chosen.source); }
}
