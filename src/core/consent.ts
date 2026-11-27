// Ambient write-tool gate delegated directly to @elicollinson/solenoid-security
// so solenoid-engine Agents and legacy consent helpers share one AsyncLocalStorage.
export {
  currentToolGate as currentConsent,
  withToolGate as withConsent,
  currentToolGate,
  withToolGate,
  type ToolGate as ConsentGate,
  type ToolRequest as ConsentRequest,
  type ToolVerdict as ConsentVerdict,
  type ToolGate,
  type ToolRequest,
  type ToolVerdict,
} from "@elicollinson/solenoid-security";
