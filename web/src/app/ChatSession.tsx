import { createContext, useContext } from "react";
import type { ChatState } from "./chat";
import type { VoiceModeState } from "./useVoiceMode";

/** Owned by AgentHome for the lifetime of this loaded app, across both frames. */
export interface ChatSession {
  chat: ChatState;
  voice: VoiceModeState;
}

export const ChatSessionContext = createContext<ChatSession | null>(null);

export function useChatSession(): ChatSession {
  const session = useContext(ChatSessionContext);
  if (!session) throw new Error("Chat requires an app session");
  return session;
}
