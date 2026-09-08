import { useCallback, useEffect, useRef, useState } from "react";

export interface UseVoiceModeOptions {
  conversationId: string | null;
  onTurnComplete?: () => void;
}

export interface VoiceModeState {
  active: boolean;
  status: "idle" | "connecting" | "open" | "error";
  isSpeaking: boolean;
  isMuted: boolean;
  error: string | null;
  analyserNode: AnalyserNode | null;
  startVoice: () => Promise<void>;
  stopVoice: () => void;
  toggleMute: () => void;
}

export function useVoiceMode({ conversationId, onTurnComplete }: UseVoiceModeOptions): VoiceModeState {
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState<"idle" | "connecting" | "open" | "error">("idle");
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analyserNode, setAnalyserNode] = useState<AnalyserNode | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const queuedSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const nextPlayTimeRef = useRef<number>(0);
  const isMutedRef = useRef(false);

  // Sync ref
  isMutedRef.current = isMuted;

  const cleanup = useCallback(() => {
    // 1. Stop mic tracks
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    // 2. Disconnect processor
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    // 3. Stop queued audio sources
    for (const source of queuedSourcesRef.current) {
      try {
        source.stop();
        source.disconnect();
      } catch {
        // Ignored
      }
    }
    queuedSourcesRef.current = [];

    // 4. Close WebSocket
    if (wsRef.current) {
      // A deliberate stop must not let a late close event clean up a new session.
      wsRef.current.onopen = null;
      wsRef.current.onmessage = null;
      wsRef.current.onerror = null;
      wsRef.current.onclose = null;
      try {
        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "stop" }));
        }
        wsRef.current.close();
      } catch {
        // Ignored
      }
      wsRef.current = null;
    }

    // 5. Close AudioContext
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }

    setActive(false);
    setStatus("idle");
    setIsSpeaking(false);
    setAnalyserNode(null);
  }, []);

  // Cleanup on unmount or when conversation changes
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [conversationId, cleanup]);

  const startVoice = useCallback(async () => {
    if (!conversationId) return;

    try {
      cleanup();
      setError(null);
      setStatus("connecting");

      // 1. Initialize AudioContext
      const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audioCtx = new AudioCtxClass();
      if (audioCtx.state === "suspended") {
        await audioCtx.resume();
      }
      audioCtxRef.current = audioCtx;
      nextPlayTimeRef.current = audioCtx.currentTime;

      // 2. Analyser for retro wiggly line visualizer
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      setAnalyserNode(analyser);

      // 3. Microphone capture
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;

      const micSource = audioCtx.createMediaStreamSource(stream);
      micSource.connect(analyser);

      // 4. ScriptProcessor to extract 16kHz PCM audio chunks
      // Buffer size 4096 gives ~85ms at 48kHz or ~256ms at 16kHz
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (isMutedRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        const inputData = e.inputBuffer.getChannelData(0);
        // Resample input to 16kHz PCM if needed
        const inputRate = audioCtx.sampleRate;
        const targetRate = 16000;
        const ratio = inputRate / targetRate;
        const targetLength = Math.round(inputData.length / ratio);
        const pcm16 = new Int16Array(targetLength);

        for (let i = 0; i < targetLength; i++) {
          const srcIndex = Math.round(i * ratio);
          const sample = Math.max(-1, Math.min(1, inputData[srcIndex] ?? 0));
          pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }

        // Convert pcm16 to base64
        const uint8 = new Uint8Array(pcm16.buffer);
        let binary = "";
        const len = uint8.byteLength;
        for (let i = 0; i < len; i++) {
          binary += String.fromCharCode(uint8[i]!);
        }
        const base64Pcm = btoa(binary);

        wsRef.current.send(
          JSON.stringify({
            type: "audio",
            data: base64Pcm,
          }),
        );
      };

      micSource.connect(processor);
      // Dummy destination so processor runs
      processor.connect(audioCtx.destination);

      // 5. Connect WebSocket
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const targetId = conversationId ?? "latest";
      const wsUrl = `${proto}//${window.location.host}/api/chat/${encodeURIComponent(targetId)}/voice`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus("connecting");
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as {
            type: string;
            data?: string;
            mimeType?: string;
            text?: string;
            message?: string;
            reason?: string;
          };

          if (msg.type === "ready") {
            setStatus("open");
            setActive(true);
          } else if (msg.type === "audio" && msg.data) {
            // Play received audio
            playPcmAudio(msg.data, audioCtx, analyser);
            setIsSpeaking(true);
          } else if (msg.type === "interrupted") {
            // User interrupted the model: cut off playback
            stopAudioPlayback();
            setIsSpeaking(false);
          } else if (msg.type === "turn_complete") {
            setIsSpeaking(false);
            onTurnComplete?.();
          } else if (msg.type === "error") {
            setError(msg.message ?? "Voice stream error");
            cleanup();
            setStatus("error");
          } else if (msg.type === "close") {
            setError(msg.reason || "The voice session ended. Try starting it again.");
            cleanup();
            setStatus("error");
          }
        } catch {
          // Ignored
        }
      };

      ws.onerror = () => {
        setError("WebSocket connection failed");
        cleanup();
        setStatus("error");
      };

      ws.onclose = (event) => {
        setError((current) => current ?? (event.reason || "The voice connection closed. Try starting it again."));
        cleanup();
        setStatus("error");
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      cleanup();
      setStatus("error");
    }
  }, [conversationId, cleanup, onTurnComplete]);

  const stopAudioPlayback = () => {
    for (const source of queuedSourcesRef.current) {
      try {
        source.stop();
        source.disconnect();
      } catch {
        // Ignored
      }
    }
    queuedSourcesRef.current = [];
    if (audioCtxRef.current) {
      nextPlayTimeRef.current = audioCtxRef.current.currentTime;
    }
  };

  const playPcmAudio = (
    base64Data: string,
    audioCtx: AudioContext,
    analyser: AnalyserNode,
  ) => {
    try {
      const binaryString = atob(base64Data);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const int16 = new Int16Array(bytes.buffer);
      const sampleRate = 24000;
      const audioBuffer = audioCtx.createBuffer(1, int16.length, sampleRate);
      const channelData = audioBuffer.getChannelData(0);

      for (let i = 0; i < int16.length; i++) {
        channelData[i] = int16[i]! / 32768.0;
      }

      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;

      // Connect source to speaker and analyser
      source.connect(audioCtx.destination);
      source.connect(analyser);

      const currentTime = audioCtx.currentTime;
      const startTime = Math.max(currentTime, nextPlayTimeRef.current);
      source.start(startTime);
      nextPlayTimeRef.current = startTime + audioBuffer.duration;

      queuedSourcesRef.current.push(source);
      source.onended = () => {
        const idx = queuedSourcesRef.current.indexOf(source);
        if (idx !== -1) queuedSourcesRef.current.splice(idx, 1);
        if (queuedSourcesRef.current.length === 0) {
          setIsSpeaking(false);
        }
      };
    } catch {
      // Ignored
    }
  };

  const stopVoice = useCallback(() => {
    cleanup();
  }, [cleanup]);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const next = !prev;
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getAudioTracks().forEach((track) => {
          track.enabled = !next;
        });
      }
      return next;
    });
  }, []);

  return {
    active,
    status,
    isSpeaking,
    isMuted,
    error,
    analyserNode,
    startVoice,
    stopVoice,
    toggleMute,
  };
}
