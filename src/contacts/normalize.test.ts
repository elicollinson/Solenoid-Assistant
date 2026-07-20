import { describe, expect, test } from "bun:test";
import { lastTenDigits, normalizeEmail, normalizePhone } from "./normalize";

describe("normalizePhone", () => {
  // Acceptance criteria: all five spec §5.1 vectors ⇒ +19379749491
  const vectors = [
    "(937) 974-9491",
    "937-974-9491",
    "+1 937 974 9491",
    "+19379749491",
    "9379749491",
  ];
  for (const raw of vectors) {
    test(`"${raw}" ⇒ +19379749491`, () => {
      expect(normalizePhone(raw)).toBe("+19379749491");
    });
  }

  test("respects a non-US default country code for 10-digit numbers", () => {
    expect(normalizePhone("9379749491", "44")).toBe("+449379749491");
  });

  test("7–15 digit international numbers pass through with +", () => {
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
  });

  test("short codes (<7 digits) return null", () => {
    expect(normalizePhone("86753")).toBe(null);
  });

  test("unicode spaces and stray metadata are absorbed", () => {
    expect(normalizePhone(" +1 937 974 9491x")).toBe("+19379749491");
  });
});

describe("normalizeEmail", () => {
  test("trims and lowercases", () => {
    expect(normalizeEmail("  Friend@Example.COM ")).toBe("friend@example.com");
  });
});

describe("lastTenDigits", () => {
  test("returns last 10 digits for long numbers", () => {
    expect(lastTenDigits("+19379749491")).toBe("9379749491");
  });
  test("undefined for short codes", () => {
    expect(lastTenDigits("86753")).toBe(null);
  });
});
