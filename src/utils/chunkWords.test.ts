import { describe, expect, test } from "bun:test";
import { chunkWords } from "./chunkWords";

describe("chunkWords", () => {
  test("supports deterministic chunking for evaluations", () => {
    expect(chunkWords("one two three four five six", 4, () => 0)).toEqual([
      "one two",
      "three four",
      "five six",
    ]);
    expect(chunkWords("one two three four five six", 4, () => 0.99)).toEqual([
      "one two three four",
      "five six",
    ]);
  });

  test("rejects invalid maximum lengths", () => {
    expect(() => chunkWords("one two", 1)).toThrow(/at least 2/);
  });
});
