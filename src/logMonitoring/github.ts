import { sanitize } from "./sanitize";

export interface Issue { number: number; url: string; title: string; body: string; state: string }
export interface GitHubIssues {
  list(signal: AbortSignal): Promise<Issue[]>;
  create(title: string, body: string, signal: AbortSignal): Promise<Issue>;
}
export const marker = (scope: string, id: string) => `<!-- solenoid-log:${scope}:${id} -->`;
export class GitHubClient implements GitHubIssues {
  constructor(private repository: string, private token: string, private fetchFn: typeof fetch = fetch) {}
  private async request(path: string, signal: AbortSignal, body?: { title: string; body: string }) {
    if (!this.token) throw new Error("LOG_MONITOR_GITHUB_TOKEN is required");
    // Fixed API host and operator-configured repo; logs/model cannot redirect credentials.
    const response = await this.fetchFn(`https://api.github.com/repos/${this.repository}/${path}`, {
      method: body ? "POST" : "GET", redirect: "error",
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.token}`, "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    });
    if (!response.ok) throw new Error(`GitHub issue request failed (${response.status}); no automatic POST retry`);
    return response.json();
  }
  async list(signal: AbortSignal): Promise<Issue[]> {
    const result: Issue[] = [];
    for (let page = 1; page <= 100; page++) {
      const rows = await this.request(`issues?state=all&sort=created&direction=desc&per_page=100&page=${page}`, signal);
      if (!Array.isArray(rows)) throw new Error("Invalid GitHub issue listing");
      for (const row of rows) if (!row.pull_request) result.push(this.parse(row));
      if (rows.length < 100) return result;
    }
    throw new Error("GitHub issue listing limit exceeded; deduplication incomplete");
  }
  async create(title: string, body: string, signal: AbortSignal) {
    return this.parse(await this.request("issues", signal, { title, body }));
  }
  private parse(value: unknown): Issue {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid GitHub issue response");
    const row = value as Record<string, unknown>;
    if (!Number.isInteger(row.number) || typeof row.html_url !== "string" || !row.html_url.startsWith(`https://github.com/${this.repository}/issues/`)) throw new Error("Invalid GitHub issue response");
    return { number: row.number as number, url: row.html_url, title: String(row.title ?? ""), body: String(row.body ?? ""), state: String(row.state ?? "unknown") };
  }
}
export function issueForModel(issue: Issue) {
  return { number: issue.number, url: issue.url, title: sanitize(issue.title), body: sanitize(issue.body), state: issue.state };
}
