import { sanitize } from "./sanitize";

export interface Issue { number: number; url: string; title: string; body: string; state: string }
export interface GitHubIssues {
  list(signal: AbortSignal): Promise<Issue[]>;
  create(title: string, body: string, signal: AbortSignal): Promise<Issue>;
}
export const marker = (scope: string, id: string) => `<!-- solenoid-log:${scope}:${id} -->`;
export class GitHubClient implements GitHubIssues {
  constructor(private repository: string, private token: string, private fetchFn: typeof fetch = fetch) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid configured GitHub repository");
  }
  private async request(path: string, signal: AbortSignal, body?: { title: string; body: string }) {
    signal.throwIfAborted();
    if (!this.token) throw new Error("LOG_MONITOR_GITHUB_TOKEN is required");
    // Fixed API host and operator-configured repo; logs/model cannot redirect credentials.
    const response = await this.fetchFn(`https://api.github.com/repos/${this.repository}/${path}`, {
      method: body ? "POST" : "GET", redirect: "error",
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.token}`, "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    });
    if (!response.ok) throw new Error(`GitHub issue request failed (${response.status}); retry-after=${response.headers.get("retry-after") ?? "unknown"}; rate-limit-reset=${response.headers.get("x-ratelimit-reset") ?? "unknown"}; no automatic POST retry`);
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
  async page(signal: AbortSignal, options: { page: number; perPage: number; state: "open" | "closed" | "all" }) {
    const rows = await this.request(`issues?state=${options.state}&sort=created&direction=desc&per_page=${options.perPage}&page=${options.page}`, signal);
    if (!Array.isArray(rows)) throw new Error("Invalid GitHub issue listing");
    return { issues: rows.filter(row => !row.pull_request).map(row => this.parse(row)),
      nextPage: rows.length === options.perPage ? options.page + 1 : null };
  }
  async read(number: number, signal: AbortSignal) {
    const row = await this.request(`issues/${number}`, signal);
    if (row && typeof row === "object" && "pull_request" in row) throw new Error("Requested number is a pull request, not an issue");
    const issue = this.parse(row);
    if (issue.number !== number) throw new Error("GitHub returned a different issue number");
    return issue;
  }
  async create(title: string, body: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.token) throw new Error("LOG_MONITOR_GITHUB_TOKEN is required; no request was sent");
    try {
      return this.parse(await this.request("issues", signal, { title, body }));
    } catch (error) {
      throw new Error("GitHub issue creation was not verified; the outcome may be unknown. Read/search the repository before attempting another create. No automatic POST retry. " + (error instanceof Error && error.message.startsWith("GitHub issue request failed") ? error.message : ""), { cause: error });
    }
  }
  private parse(value: unknown): Issue {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid GitHub issue response");
    const row = value as Record<string, unknown>;
    if (!Number.isInteger(row.number) || Number(row.number) <= 0 || typeof row.html_url !== "string" || row.html_url !== `https://github.com/${this.repository}/issues/${row.number}`) throw new Error("Invalid GitHub issue response");
    return { number: row.number as number, url: row.html_url, title: String(row.title ?? ""), body: String(row.body ?? ""), state: String(row.state ?? "unknown") };
  }
}
export function issueForModel(issue: Issue) {
  return { number: issue.number, url: issue.url, title: sanitize(issue.title), body: sanitize(issue.body), state: issue.state };
}
