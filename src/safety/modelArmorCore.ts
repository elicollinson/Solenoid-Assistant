import { GoogleAuth, type JWTInput } from "google-auth-library";

export type PromptTextParts = readonly [string, ...string[]];

export interface ModelArmorAssessment {
  flagged: boolean;
  label: "BENIGN" | "MALICIOUS";
  score: number;
  filterMatchState: "MATCH_FOUND" | "NO_MATCH_FOUND" | string;
  invocationResult: "SUCCESS" | string;
  confidenceLevel?: string;
  filterResults?: Record<string, unknown>;
}

export interface ModelArmorScannerOptions {
  projectId?: string;
  location?: string;
  templateId?: string;
  apiKey?: string;
  apiEndpoint?: string;
  credentialsJson?: string;
  credentialsBase64?: string;
  fetchFn?: typeof fetch;
  getAuthToken?: () => Promise<string | undefined>;
}

interface ResolvedModelArmorScannerOptions {
  projectId?: string;
  location: string;
  templateId: string;
  apiKey?: string;
  apiEndpoint?: string;
  credentialsJson?: string;
  credentialsBase64?: string;
  fetchFn: typeof fetch;
  getAuthToken?: () => Promise<string | undefined>;
}

const EMPTY_ASSESSMENT: ModelArmorAssessment = {
  flagged: false,
  label: "BENIGN",
  score: 0,
  filterMatchState: "NO_MATCH_FOUND",
  invocationResult: "SUCCESS",
};

function combineParts(parts: readonly string[]): string {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new TypeError("Model Armor input must contain at least one string");
  }
  for (const part of parts) {
    if (typeof part !== "string") {
      throw new TypeError("Every Model Armor input part must be a string");
    }
  }
  return parts.join("\n");
}

export class ModelArmorScanner {
  private readonly options: ResolvedModelArmorScannerOptions;
  private auth?: GoogleAuth;

  constructor(options: ModelArmorScannerOptions = {}) {
    this.options = {
      projectId: options.projectId,
      location: options.location ?? "us-central1",
      templateId: options.templateId ?? "base-detector",
      apiKey: options.apiKey,
      apiEndpoint: options.apiEndpoint,
      credentialsJson: options.credentialsJson,
      credentialsBase64: options.credentialsBase64,
      fetchFn: options.fetchFn ?? fetch,
      getAuthToken: options.getAuthToken,
    };
  }

  private async getAuthorizationHeader(): Promise<Record<string, string>> {
    if (this.options.apiKey) {
      return { "x-goog-api-key": this.options.apiKey };
    }

    if (this.options.getAuthToken) {
      const token = await this.options.getAuthToken();
      if (token) {
        return { Authorization: `Bearer ${token}` };
      }
    }

    if (!this.auth) {
      let credentials: JWTInput | undefined;
      const credsJson =
        this.options.credentialsJson ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
      const credsBase64 =
        this.options.credentialsBase64 ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64;

      if (credsJson) {
        try {
          credentials = JSON.parse(credsJson);
        } catch (error) {
          throw new Error("Failed to parse GOOGLE_APPLICATION_CREDENTIALS_JSON as valid JSON", { cause: error });
        }
      } else if (credsBase64) {
        try {
          const decoded = Buffer.from(credsBase64, "base64").toString("utf8");
          credentials = JSON.parse(decoded);
        } catch (error) {
          throw new Error("Failed to parse GOOGLE_APPLICATION_CREDENTIALS_BASE64 as valid base64 JSON", { cause: error });
        }
      }

      this.auth = new GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        ...(credentials ? { credentials } : {}),
      });
    }

    const client = await this.auth.getClient();
    const tokenResponse = await client.getAccessToken();
    const token = tokenResponse?.token;

    if (!token) {
      throw new Error(
        "Failed to obtain Google Cloud access token for Model Armor. " +
          "Ensure application default credentials are configured (e.g. gcloud auth application-default login) " +
          "or set GOOGLE_APPLICATION_CREDENTIALS.",
      );
    }

    return { Authorization: `Bearer ${token}` };
  }

  private getEndpointUrl(): string {
    const { projectId, location, templateId, apiEndpoint } = this.options;
    if (!projectId) {
      throw new Error(
        "MODEL_ARMOR_PROJECT_ID (or GOOGLE_CLOUD_PROJECT / GCP_PROJECT) must be set to use Google Cloud Model Armor.",
      );
    }
    if (!templateId) {
      throw new Error(
        "MODEL_ARMOR_TEMPLATE_ID must be set to use Google Cloud Model Armor.",
      );
    }

    const base = apiEndpoint
      ? apiEndpoint.replace(/\/+$/, "")
      : `https://modelarmor.${location}.rep.googleapis.com`;

    const path = `${base}/v1/projects/${projectId}/locations/${location}/templates/${templateId}:sanitizeUserPrompt`;
    return this.options.apiKey
      ? `${path}?key=${encodeURIComponent(this.options.apiKey)}`
      : path;
  }

  async assess(parts: PromptTextParts): Promise<ModelArmorAssessment> {
    const text = combineParts(parts);
    if (!text.trim()) {
      return { ...EMPTY_ASSESSMENT };
    }

    const url = this.getEndpointUrl();
    const authHeaders = await this.getAuthorizationHeader();

    const response = await this.options.fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "solenoid-assistant/1.0",
        ...authHeaders,
      },
      body: JSON.stringify({
        userPromptData: {
          text,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `Model Armor request failed: HTTP ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    const data = (await response.json()) as {
      sanitizationResult?: {
        filterMatchState?: string;
        invocationResult?: string;
        filterResults?: Record<string, unknown>;
      };
    };

    const sanitizationResult = data.sanitizationResult;
    if (!sanitizationResult) {
      throw new Error("Model Armor response did not contain sanitizationResult");
    }

    const filterMatchState = sanitizationResult.filterMatchState ?? "NO_MATCH_FOUND";
    const flagged = filterMatchState === "MATCH_FOUND";
    const rawFilterResults = sanitizationResult.filterResults as
      | Record<string, Record<string, Record<string, unknown>>>
      | undefined;
    const confidenceLevel =
      typeof rawFilterResults?.pi_and_jailbreak?.piAndJailbreakFilterResult?.confidenceLevel === "string"
        ? (rawFilterResults.pi_and_jailbreak.piAndJailbreakFilterResult.confidenceLevel as string)
        : undefined;

    return {
      flagged,
      label: flagged ? "MALICIOUS" : "BENIGN",
      score: flagged ? 1 : 0,
      filterMatchState,
      invocationResult: sanitizationResult.invocationResult ?? "SUCCESS",
      confidenceLevel,
      filterResults: sanitizationResult.filterResults,
    };
  }

  async containsPromptInjection(parts: PromptTextParts): Promise<boolean> {
    return (await this.assess(parts)).flagged;
  }

  async dispose(): Promise<void> {
    this.auth = undefined;
  }
}
