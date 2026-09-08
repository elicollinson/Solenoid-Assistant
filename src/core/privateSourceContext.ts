import { AsyncLocalStorage } from "node:async_hooks";
// Candidate screenshots may be rejected. Their contents must never enter
// durable logs or traces before the retention decision.
export const privateSourceContext = new AsyncLocalStorage<boolean>();
