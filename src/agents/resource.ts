import type { Agent } from "../core/rawAgent";

export interface AgentResource<T extends Agent = Agent> {
  agent: T;
  close(): Promise<void>;
}

export function agentResource<T extends Agent>(
  agent: T,
  close?: () => void | Promise<void>,
): AgentResource<T> {
  let closed = false;
  return {
    agent,
    async close() {
      if (closed) return;
      closed = true;
      await close?.();
    },
  };
}
