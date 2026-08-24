import { describe, expect, test } from "bun:test";
import {
  inputMessageAttributes,
  outputMessageAttributes,
  safeMessagesJson,
} from "./spans";
import type { ChatMessage } from "../providers";

const assistant = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  role: "assistant",
  content: "",
  ...over,
});

describe("reasoning on LLM spans", () => {
  test("a reasoning-only turn is no longer silent in the trace", () => {
    // The regression this guards: `thinking` was never recorded, so a turn that
    // spent every completion token on reasoning appeared in Phoenix as empty
    // output with a non-zero token count and nothing to explain it.
    const attrs = outputMessageAttributes(
      assistant({ content: "", thinking: "The average is 7.5, so it passes." }),
    );

    expect(attrs["llm.output_messages.0.message.reasoning"]).toBe(
      "The average is 7.5, so it passes.",
    );
    expect(attrs["llm.output_messages.0.message.content"]).toBe("");
  });

  test("the attribute is omitted entirely when there is no reasoning", () => {
    const attrs = outputMessageAttributes(assistant({ content: "done" }));
    expect(attrs).not.toHaveProperty("llm.output_messages.0.message.reasoning");
  });

  test("long reasoning is truncated with a visible marker", () => {
    const attrs = outputMessageAttributes(assistant({ thinking: "x".repeat(5000) }));
    const reasoning = attrs["llm.output_messages.0.message.reasoning"] as string;

    expect(reasoning).toContain("[truncated 3000 chars]");
    expect(reasoning.length).toBeLessThan(5000);
  });

  test("reasoning does not displace content in message.contents", () => {
    // Phoenix renders `message.contents` in place of `message.content`, so
    // reasoning must not be written there or it would hide the answer.
    const attrs = outputMessageAttributes(assistant({ content: "answer", thinking: "reasons" }));
    expect(Object.keys(attrs).some((k) => k.includes("message.contents"))).toBe(false);
    expect(attrs["llm.output_messages.0.message.content"]).toBe("answer");
  });

  test("reasoning carried in replayed history is recorded per input message", () => {
    const attrs = inputMessageAttributes([
      { role: "user", content: "grade it" },
      assistant({ content: "", thinking: "pondering" }),
    ]);

    expect(attrs["llm.input_messages.1.message.reasoning"]).toBe("pondering");
    expect(attrs).not.toHaveProperty("llm.input_messages.0.message.reasoning");
  });

  test("records multimodal metadata without storing base64 image bytes", () => {
    const attrs = inputMessageAttributes([
      {
        role: "user",
        content: "inspect",
        images: [{ mimeType: "image/png", data: "secret-base64" }],
      },
    ]);
    const serialized = JSON.stringify(attrs);
    expect(serialized).toContain("image/png");
    expect(serialized).toContain("omitted 13 chars");
    expect(serialized).not.toContain("secret-base64");
    expect(safeMessagesJson([
      {
        role: "user",
        content: "inspect",
        images: [{ mimeType: "image/png", data: "secret-base64" }],
      },
    ])).not.toContain("secret-base64");
  });

  test("records the normalized finish reason", () => {
    const attrs = outputMessageAttributes(
      assistant({ content: "partial", finishReason: "length" }),
    );
    expect(attrs["llm.output_messages.0.message.finish_reason"]).toBe("length");
  });
});
