import { RetroWigglyLine } from "../kit";
import type { VoiceModeState } from "./useVoiceMode";

/** A single keyboard/touch target; the waveform inside has no nested controls. */
export function VoiceIndicator({ voice, onReturn, phone = false }: {
  voice: VoiceModeState;
  onReturn: () => void;
  phone?: boolean;
}) {
  if (!voice.active && voice.status !== "connecting") return null;
  const label = voice.status === "connecting" ? "Voice connecting" : voice.isMuted ? "Voice muted" : "Voice active";
  return (
    <button
      type="button"
      aria-label={`${label}. Return to ongoing conversation`}
      title="Return to ongoing conversation"
      onClick={onReturn}
      style={{
        position: "absolute",
        right: phone ? "var(--gutter-phone)" : "var(--sp-8)",
        bottom: phone ? "var(--ask-bottom)" : "var(--sp-8)",
        zIndex: 30,
        width: 164,
        padding: "var(--sp-3)",
        border: "var(--border-strong)",
        borderRadius: "var(--radius-card)",
        background: "var(--surface-panel)",
        color: "var(--text-1)",
        boxShadow: "var(--shadow-float)",
        cursor: "pointer",
        font: "var(--text-mono-meta)",
      }}
    >
      <span aria-hidden="true" style={{ display: "block" }}>
        <RetroWigglyLine compact active={voice.active} analyserNode={voice.analyserNode}
          isSpeaking={voice.isSpeaking} isMuted={voice.isMuted} />
        {label}
      </span>
    </button>
  );
}
