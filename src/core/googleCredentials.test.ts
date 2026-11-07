import { expect, test } from "bun:test";
import { GoogleCredentialsError, googleCredentialSource, loadGoogleCredentials } from "./googleCredentials";

const fixture = (label: string) => JSON.stringify({ type: "service_account", client_email: `${label}@example.invalid`, private_key: "synthetic-secret" });
const base64 = (text: string) => Buffer.from(text).toString("base64");
const keys = ["MODEL_ARMOR_CREDENTIALS_JSON", "GOOGLE_APPLICATION_CREDENTIALS_JSON", "MODEL_ARMOR_CREDENTIALS_BASE64", "GOOGLE_APPLICATION_CREDENTIALS_BASE64"] as const;

test("both applications select the same identity with the existing JSON-before-base64 precedence", () => {
  const env: Record<string, string> = Object.fromEntries(keys.map(key => [key, key.endsWith("BASE64") ? base64(fixture(key)) : fixture(key)]));
  for (const key of keys) {
    expect(googleCredentialSource({}, env)).toBe(key);
    expect(loadGoogleCredentials({}, env)?.client_email).toBe(`${key}@example.invalid`);
    expect(loadGoogleCredentials({ credentialsJson: env.MODEL_ARMOR_CREDENTIALS_JSON, credentialsBase64: env.MODEL_ARMOR_CREDENTIALS_BASE64 }, env))
      .toEqual(loadGoogleCredentials({}, env));
    delete env[key];
  }
  expect(loadGoogleCredentials({}, env)).toBeUndefined();
  expect(googleCredentialSource({}, env)).toBe("adc");
});

test("explicit Model Armor scanner options retain their precedence within each format", () => {
  const env = { MODEL_ARMOR_CREDENTIALS_JSON: fixture("environment"), GOOGLE_APPLICATION_CREDENTIALS_JSON: fixture("general") };
  expect(loadGoogleCredentials({ credentialsJson: fixture("explicit") }, env)?.client_email).toBe("explicit@example.invalid");
  expect(loadGoogleCredentials({ credentialsBase64: base64(fixture("explicit")) }, { GOOGLE_APPLICATION_CREDENTIALS_JSON: fixture("general") })?.client_email)
    .toBe("general@example.invalid");
});

test("standard ADC remains untouched and credential metadata never becomes configuration output", () => {
  const env = { GOOGLE_APPLICATION_CREDENTIALS: "/nonexistent/never-read.json", MODEL_ARMOR_CREDENTIALS_JSON: "  " };
  expect(loadGoogleCredentials({}, env)).toBeUndefined();
  expect(googleCredentialSource({}, env)).toBe("adc");
  expect(googleCredentialSource({}, { MODEL_ARMOR_CREDENTIALS_JSON: "secret malformed content" })).toBe("MODEL_ARMOR_CREDENTIALS_JSON");
});

test("malformed higher-priority credentials fail closed without parser causes or secret text", () => {
  for (const bad of ["synthetic-secret{", "null", "[]", "42", '"synthetic-secret"', "{}", '{"type":12}']) {
    try {
      loadGoogleCredentials({}, { MODEL_ARMOR_CREDENTIALS_JSON: bad, GOOGLE_APPLICATION_CREDENTIALS_JSON: fixture("fallback") });
      throw new Error("unexpected acceptance");
    } catch (error) {
      expect(error).toBeInstanceOf(GoogleCredentialsError);
      expect(String(error)).not.toContain("synthetic-secret");
      expect((error as Error).cause).toBeUndefined();
    }
  }
});

test("base64 accepts wrapped or unpadded encoding and rejects malformed encoding and JSON", () => {
  const encoded = base64(fixture("wrapped"));
  expect(loadGoogleCredentials({}, { MODEL_ARMOR_CREDENTIALS_BASE64: encoded.replace(/(.{20})/g, "$1\n") })?.client_email).toBe("wrapped@example.invalid");
  expect(loadGoogleCredentials({}, { MODEL_ARMOR_CREDENTIALS_BASE64: encoded.replace(/=+$/, "") })?.client_email).toBe("wrapped@example.invalid");
  for (const value of ["%%%", `${encoded}!`, base64("synthetic-secret{"), base64("null"), Buffer.from([255]).toString("base64")]) {
    expect(() => loadGoogleCredentials({}, { MODEL_ARMOR_CREDENTIALS_BASE64: value })).toThrow(GoogleCredentialsError);
  }
});

test("Google retains validation of user and federated credential formats", () => {
  for (const type of ["authorized_user", "external_account", "service_account"]) {
    expect(loadGoogleCredentials({}, { GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify({ type }) })).toEqual({ type });
  }
});
