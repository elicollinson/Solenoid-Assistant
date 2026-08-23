import { describe, expect, test } from "bun:test";
import { evaluateArithmetic } from "./arithmetic";

describe("evaluateArithmetic", () => {
  test("evaluates arithmetic with precedence, parentheses, and unary signs", () => {
    expect(evaluateArithmetic("2 + 3 * 4")).toBe(14);
    expect(evaluateArithmetic("-(2 + 3) * 4")).toBe(-20);
  });

  test("rejects JavaScript and non-finite results", () => {
    expect(() => evaluateArithmetic("process.exit(1)")).toThrow(/Unsupported token/);
    expect(() => evaluateArithmetic("1 / 0")).toThrow(/finite/);
  });
});
