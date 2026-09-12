import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Button } from "../core/Button";

export interface RetroWigglyLineProps {
  active: boolean;
  /** Waveform only, for the floating return-to-chat control. */
  compact?: boolean;
  analyserNode?: AnalyserNode | null;
  isSpeaking?: boolean;
  isMuted?: boolean;
  onToggleMute?: () => void;
  onEndVoice?: () => void;
  style?: CSSProperties;
}

/**
 * Refined Analog Sinusoidal Audio Visualizer.
 *
 * Indicates that the Gemini Live real-time audio stream is active.
 * Features a clean analog sinusoidal curve, subtle center axis, and
 * dynamic frequency reactivity, seamlessly styled for both Paper (light)
 * and Dusk (dark) themes using Solenoid's design tokens.
 */
export function RetroWigglyLine({
  active,
  compact = false,
  analyserNode,
  isSpeaking = false,
  isMuted = false,
  onToggleMute,
  onEndVoice,
  style,
}: RetroWigglyLineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number>(0);
  const timeRef = useRef<number>(0);
  const smoothedLevelRef = useRef<number>(0.15);
  const [pulse, setPulse] = useState(true);

  // Gentle pulse for the live stream indicator dot
  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => setPulse((p) => !p), 1000);
    return () => clearInterval(interval);
  }, [active]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const updateDimensions = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const dpr = window.devicePixelRatio || 1;
      const w = parent.clientWidth || 600;
      const h = 48;

      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;

      ctx.resetTransform();
      ctx.scale(dpr, dpr);
    };

    updateDimensions();
    window.addEventListener("resize", updateDimensions);

    const dataArray = analyserNode ? new Uint8Array(analyserNode.frequencyBinCount) : null;

    const render = () => {
      timeRef.current += 0.035;
      const t = timeRef.current;

      const parent = canvas.parentElement;
      const width = parent?.clientWidth || 600;
      const height = 48;
      const cy = height / 2;

      // Extract current theme CSS tokens from the document/canvas
      const computed = getComputedStyle(canvas);
      const strokeColor = isMuted
        ? computed.getPropertyValue("--signal-amber").trim() || "#d97706"
        : computed.getPropertyValue("--accent").trim() ||
          computed.getPropertyValue("--signal-green").trim() ||
          "#0d9488";
      const axisColor = computed.getPropertyValue("--line").trim() || "rgba(0, 0, 0, 0.12)";

      // Audio level reactivity
      let currentLevel = 0.12; // calm idle baseline
      if (analyserNode && dataArray) {
        analyserNode.getByteFrequencyData(dataArray);
        let sum = 0;
        const len = Math.min(dataArray.length, 64);
        for (let i = 0; i < len; i++) {
          sum += dataArray[i]!;
        }
        const avg = sum / (len * 255);
        currentLevel = Math.max(0.12, avg * 1.5);
      } else if (isSpeaking) {
        currentLevel = 0.5 + 0.2 * Math.sin(t * 6);
      }

      // Smooth amplitude transitions
      smoothedLevelRef.current += (currentLevel - smoothedLevelRef.current) * 0.12;
      const amp = smoothedLevelRef.current * (height * 0.38);

      // Clear previous frame
      ctx.clearRect(0, 0, width, height);

      // 1. Subtle analog center reference axis
      ctx.strokeStyle = axisColor;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(8, cy);
      ctx.lineTo(width - 8, cy);
      ctx.stroke();
      ctx.setLineDash([]);

      // 2. Faint secondary harmonic trace (analog oscilloscope echo)
      ctx.save();
      ctx.globalAlpha = 0.2;
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const step = 2;
      for (let x = 0; x <= width; x += step * 2) {
        const envelope = Math.sin((Math.PI * x) / width);
        const w = Math.sin(0.016 * x + (t - 0.12) * 2.5) + 0.25 * Math.sin(0.038 * x - (t - 0.12) * 3.8);
        const y = cy + w * (amp * 0.8) * envelope;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();

      // 3. Primary refined sinusoidal wave
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let x = 0; x <= width; x += step) {
        // Taper to zero at both extremities
        const envelope = Math.sin((Math.PI * x) / width);
        const w1 = Math.sin(0.016 * x + t * 2.5);
        const w2 = 0.28 * Math.sin(0.038 * x - t * 3.8);
        const y = cy + (w1 + w2) * amp * envelope;

        if (x === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();

      animationFrameRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameRef.current);
      window.removeEventListener("resize", updateDimensions);
    };
  }, [active, analyserNode, isSpeaking, isMuted]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-2)",
        padding: "var(--sp-3) var(--sp-4)",
        borderRadius: "var(--radius-card)",
        border: "var(--border)",
        background: "var(--surface-sunken)",
        boxSizing: "border-box",
        ...(compact ? { padding: 0, border: "none", background: "transparent" } : {}),
        ...style,
      }}
    >
      {compact ? null : <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--sp-3)",
          fontSize: "11px",
          font: "var(--text-mono-meta)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--text-3)",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
          <span
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              backgroundColor: isMuted ? "var(--signal-amber)" : "var(--signal-green)",
              opacity: pulse ? 1 : 0.45,
              transition: "opacity 0.4s ease, background-color 0.2s ease",
              flexShrink: 0,
            }}
          />
          <span style={{ color: "var(--text-1)", fontWeight: 500 }}>
            {isMuted ? "Stream Open · Muted" : "Live Stream Open"}
          </span>
          <span style={{ color: "var(--text-4)" }}>· Gemini 3.1</span>
        </span>

        <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
          {onToggleMute ? (
            <Button
              variant="bare"
              size="sm"
              onClick={onToggleMute}
              style={{
                font: "var(--text-mono-control)",
                fontSize: "10px",
                letterSpacing: "0.06em",
                padding: "2px 8px",
                minHeight: "unset",
                color: isMuted ? "var(--signal-amber-text)" : "var(--text-2)",
              }}
            >
              {isMuted ? "Unmute" : "Mute"}
            </Button>
          ) : null}

          {onEndVoice ? (
            <Button
              variant="quiet"
              size="sm"
              onClick={onEndVoice}
              style={{
                font: "var(--text-mono-control)",
                fontSize: "10px",
                letterSpacing: "0.06em",
                padding: "2px 8px",
                minHeight: "unset",
                color: "var(--text-2)",
              }}
            >
              End Voice
            </Button>
          ) : null}
        </div>
      </div>}

      <div style={{ width: "100%", height: "48px", overflow: "hidden", position: "relative" }}>
        <canvas ref={canvasRef} style={{ display: "block", width: "100%", height: "100%" }} />
      </div>
    </div>
  );
}
