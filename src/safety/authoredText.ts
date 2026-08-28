// Text this codebase wrote, so the injection screen can stop reading it.
//
// The screen exists to decide one thing: is there an instruction here that
// someone other than us put in front of the model. It cannot answer that on
// wording alone — our own tool descriptions are second-person imperatives, and
// Llama Prompt Guard 2 scores them exactly as it scores an attack. Measured: the
// nine recommendations tool descriptions are benign one at a time (0.001–0.172
// against a 0.5 threshold) and the briefing that concatenates them scores 0.63
// and is flagged. Nothing about the text tells them apart.
//
// What tells them apart is provenance, and provenance is something we know and
// the classifier does not. So we say it: every constant string this repository
// puts in front of a model registers itself here, and the screen subtracts the
// registered spans before it looks. What is left is text of unknown origin,
// which is the only thing worth an opinion. Text that redacts to nothing is
// never screened at all.
//
// This is strictly better than a per-tool "trust me" flag, which is a claim
// about a whole tool and is wrong the moment that tool returns our scaffolding
// wrapped around somebody's email. Redaction is per-span, so the mixed case —
// most of the real cases — comes out right without anybody deciding anything.
//
// ---------------------------------------------------------------------------
// THE RULE, which is the whole safety argument:
//
//   Register only a string that is a constant of the source code. Never
//   register anything with a value interpolated into it.
//
// A prompt template that splices in an iMessage is not authored text; it is an
// iMessage in a sentence we wrote. Registering its output would register the
// attacker's payload as ours and redact their instruction out of the screen's
// view — the exact hole the screen exists to close. If you cannot point at the
// literal in the source, do not register it.
// ---------------------------------------------------------------------------

/**
 * Short strings are refused. A generic sentence registered as authored would
 * silently blank itself out of every external document that happened to contain
 * it, and the shorter it is the more documents that is. Forty characters is not
 * a proof of anything; it is enough to keep a stock phrase out.
 */
export const MIN_AUTHORED_LENGTH = 40;

export interface AuthoredEntry {
  /** Where it came from, for the trace: "tool:recommendations_list". */
  label: string;
  text: string;
}

export class AuthoredTextRegistry {
  /** Keyed by text so the same string registered twice is one entry. */
  private readonly entries = new Map<string, string>();
  /** Longest first: a briefing must be removed before the tool descriptions
   *  inside it, or their removal would leave the briefing unmatchable. */
  private ordered: string[] = [];

  /**
   * Declare that this repository wrote `text`.
   *
   * Read the rule at the top of this file first. Returns whether it was new, so
   * a caller can register in a loop without counting.
   */
  register(label: string, text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length < MIN_AUTHORED_LENGTH) {
      throw new Error(
        `Authored text "${label}" is ${trimmed.length} characters; ` +
          `${MIN_AUTHORED_LENGTH} is the minimum. A string this short would redact ` +
          `itself out of documents that merely quote it.`,
      );
    }
    if (this.entries.has(trimmed)) return false;
    this.entries.set(trimmed, label);
    this.ordered = [...this.entries.keys()].sort((a, b) => b.length - a.length);
    return true;
  }

  /**
   * Register `text` if it is long enough to be worth removing, and say nothing
   * if it is not.
   *
   * For the framework's own bulk registration — every tool description, every
   * briefing — where a description too short to redact is not a mistake anyone
   * needs told about. Use `register` where you meant a specific string and want
   * to hear that it did not take.
   */
  offer(label: string, text: string): boolean {
    if (text.trim().length < MIN_AUTHORED_LENGTH) return false;
    return this.register(label, text);
  }

  /**
   * `text` with every registered span removed.
   *
   * Exact substring matching, deliberately: a fuzzy match is a way for somebody
   * to get their own text treated as ours by writing something near enough to a
   * string of ours. The cost is that a model paraphrasing its instructions is
   * not redacted — it is only screened, which is what should happen to text
   * nobody can prove we wrote.
   */
  redact(text: string): string {
    if (!text) return text;
    let out = text;
    for (const authored of this.ordered) {
      if (out.length < authored.length) continue;
      // A space rather than nothing, so removing a span cannot fuse the words
      // on either side of it into one the classifier has never seen.
      if (out.includes(authored)) out = out.split(authored).join(" ");
    }
    return out;
  }

  /** Whether anything survives redaction. Whitespace is not something to screen. */
  hasUnauthored(text: string): boolean {
    return this.redact(text).trim().length > 0;
  }

  get size(): number {
    return this.entries.size;
  }

  list(): AuthoredEntry[] {
    return [...this.entries].map(([text, label]) => ({ label, text }));
  }

  /** For tests. The process-wide registry is otherwise append-only by design. */
  clear(): void {
    this.entries.clear();
    this.ordered = [];
  }
}

/**
 * The process-wide registry.
 *
 * Process-wide rather than per-Agent because the things that register are
 * process-wide: a tool defined at module load does not know which agents will
 * hold it. Nothing here is secret and nothing is per-user — it is a list of
 * strings already compiled into the binary — so there is nothing for one agent
 * to learn from another's entries.
 */
export const authoredText = new AuthoredTextRegistry();
