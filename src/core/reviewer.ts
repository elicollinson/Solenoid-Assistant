import type { ChatMessage } from "./providers";

/** The candidate and conversation snapshot supplied to an agent reviewer. */
export interface ReviewContext {
  readonly output: string;
  readonly messages: readonly ChatMessage[];
}

/** The small contract the agent loop needs to accept or revise a candidate. */
export interface ReviewResult {
  readonly passed: boolean;
  readonly feedback: string;
}

/** An optional, independently configurable check of an agent's candidate output. */
export interface Reviewer {
  readonly name: string;
  review(context: ReviewContext): Promise<ReviewResult>;
}
