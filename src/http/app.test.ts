import { describe, expect, test } from "bun:test";
import { app } from "../index";

describe("HTTP app", () => {
  test("can be imported without opening a listener", async () => {
    expect(app.server).toBeNull();
    const response = await app.handle(new Request("http://localhost/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("registers canonical and compatibility endpoint names", async () => {
    for (const path of ["/message-extraction", "/messageExtraction"]) {
      const response = await app.handle(
        new Request(`http://localhost${path}?start=not-a-date`),
      );
      expect(response.status).toBe(400);
    }
    for (const path of ["/safety-classifier", "/safetyClassifier"]) {
      const response = await app.handle(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: "x", maxLength: 1 }),
        }),
      );
      expect(response.status).toBe(422);
    }
  });

  test("validates notion entry requests before performing a write", async () => {
    const response = await app.handle(
      new Request("http://localhost/notion-entry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test entry",
          url: "https://example.com",
          collection: "invalid",
        }),
      }),
    );

    expect(response.status).toBe(422);
  });
});
