import { z } from "zod";
import { defineTool } from "../core/tools";
import { getTrustGate } from "../contacts/trustGate";

export const lookupContactTool = defineTool({
  name: "lookup_contact",
  description:
    "Look up an iMessage/SMS handle (phone number or email) in the local macOS Contacts " +
    "(read-only). Returns whether the sender is a known/trusted contact and their display " +
    "name if available. Phone numbers may be given in any common format.",
  schema: z.object({
    handle: z
      .string()
      .min(1)
      .describe("Phone number (any format, e.g. '+19375551234' or '(937) 555-1234') or email address"),
  }),
  execute: ({ handle }) => {
    const gate = getTrustGate();
    const trusted = gate.isTrusted(handle);
    return {
      handle,
      trusted,
      name: gate.resolveName(handle),
      contactsLoaded: gate.size(),
    };
  },
});
