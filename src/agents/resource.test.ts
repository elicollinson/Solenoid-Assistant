import { describe, expect, test } from "bun:test";
import type { Agent } from "../core/rawAgent";
import { agentResource } from "./resource";

describe("agentResource", () => {
  test("closes its dependency at most once", async () => {
    let closes = 0;
    const resource = agentResource({} as Agent, () => {
      closes++;
    });
    await resource.close();
    await resource.close();
    expect(closes).toBe(1);
  });
});
