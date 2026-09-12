import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgentHome } from "./AgentHome";

// Exercise real React mounting/navigation; only browser media and HTTP are faked.
let browser: Window;
let root: Root;
let container: HTMLDivElement;
let restore: (() => void)[];
let created: number;
let transcript: string;
let sockets: FakeSocket[];
let contexts: FakeAudioContext[];
let tracks: { enabled: boolean; stopped: boolean; stop(): void }[];
let getMic: () => Promise<unknown>;

class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  closed = false;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) { sockets.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; }
  receive(message: object) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

class FakeAudioContext {
  state = "running";
  currentTime = 0;
  sampleRate = 48000;
  destination = {};
  plays = 0;
  processor = { connect() {}, disconnect() {}, onaudioprocess: null as ((event: unknown) => void) | null };
  constructor() { contexts.push(this); }
  async resume() {}
  async close() { this.state = "closed"; }
  createAnalyser() { return { fftSize: 256, frequencyBinCount: 128, getByteFrequencyData() {} }; }
  createMediaStreamSource() { return { connect() {} }; }
  createScriptProcessor() { return this.processor; }
  createBuffer(_channels: number, length: number, rate: number) {
    return { duration: length / rate, getChannelData: () => new Float32Array(length) };
  }
  createBufferSource() {
    return { buffer: null, connect() {}, disconnect() {}, stop() {}, start: () => { this.plays++; }, onended: null };
  }
}

function replace(target: object, key: string, value: unknown) {
  const prior = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  restore.push(() => { if (prior) Object.defineProperty(target, key, prior); else Reflect.deleteProperty(target, key); });
}

beforeEach(() => {
  restore = [];
  created = 0;
  transcript = "";
  sockets = [];
  contexts = [];
  tracks = [];
  browser = new Window({ url: "http://localhost:3000" });
  for (const [key, value] of Object.entries({
    window: browser, document: browser.document, navigator: browser.navigator,
    HTMLElement: browser.HTMLElement, ResizeObserver: browser.ResizeObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: (): number => 0, cancelAnimationFrame: () => {},
    WebSocket: FakeSocket, IS_REACT_ACT_ENVIRONMENT: true,
  })) replace(globalThis, key, value);
  replace(browser, "AudioContext", FakeAudioContext);
  // Canvas drawing is covered by the real browser; this suite tests ownership.
  replace(browser.HTMLCanvasElement.prototype, "getContext", () => null);
  getMic = async () => {
    const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
    tracks.push(track);
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  };
  replace(browser.navigator, "mediaDevices", { getUserMedia: () => getMic() });
  replace(globalThis, "fetch", async (input: string, options?: RequestInit) => {
    const path = new URL(input, "http://localhost").pathname;
    if (path === "/api/chat" && options?.method === "POST") return Response.json({ conversationId: `new-${++created}` });
    if (path === "/api/chat") return Response.json({ conversations: [
      { id: "old-chat", title: "Previous conversation", when: "yesterday", state: "idle", lede: "Old conversation" },
    ], waiting: 0, lede: "Your conversations", restraint: null });
    if (path.startsWith("/api/chat/")) return Response.json({
      conversationId: path.split("/").at(-1), title: null, lede: "", restraint: null,
      turns: transcript ? [{ id: "turn-1", by: "agent", at: "now", body: transcript }] : [],
    });
    if (path === "/api/home") return Response.json({
      rail: { groups: [{ label: "Assistant", items: [{ label: "Chat" }, { label: "Activity" }] }], agent: { running: 0, line: "Nothing running" } },
      header: { greeting: "Activity feed", lede: "Nothing needs you." }, sections: [],
      aside: { waiting: [], nextUp: [], worthALook: null },
    });
    throw new Error(`Unexpected request: ${input}`);
  });
  container = browser.document.createElement("div") as unknown as HTMLDivElement;
  browser.document.body.append(container as never);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
  for (const undo of restore.reverse()) undo();
});

async function mount(width: number) {
  browser.happyDOM.setWindowSize({ width, height: 840 });
  await act(async () => { root.render(<StrictMode><AgentHome /></StrictMode>); });
}
function button(text: string) {
  const found = [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button ${text}: ${container.textContent}`);
  return found;
}
async function click(text: string) { await act(async () => { button(text).click(); }); }
function indicator() { return container.querySelector<HTMLButtonElement>('button[aria-label$="Return to ongoing conversation"]'); }

for (const width of [1240, 390]) {
  test(`fresh chat and uninterrupted voice through navigation at ${width}px`, async () => {
    await mount(width);
    expect(created).toBe(1); // StrictMode effect replay must not create duplicates.
    expect(container.querySelector("h1")?.textContent).toBe("New conversation");
    await click("Activity");
    expect(indicator()).toBeNull();
    await click("Chat");
    expect(created).toBe(1);
    await click("Voice");
    const socket = sockets[0]!;
    const audio = contexts[0]!;
    expect(socket.url).toContain("/new-1/voice");
    await click("Activity");
    expect(indicator()?.getAttribute("aria-label")).toContain("Voice connecting");
    await act(async () => socket.receive({ type: "ready" }));
    expect(indicator()?.getAttribute("aria-label")).toContain("Voice active");
    expect(indicator()?.querySelector("canvas")).not.toBeNull();
    expect(indicator()?.querySelector("button")).toBeNull();
    expect(container.querySelector('[aria-label="Ask Solenoid"]')).toBeNull();
    expect(socket.closed).toBe(false);
    expect(tracks[0]!.stopped).toBe(false);
    expect(audio.state).toBe("running");

    // Microphone chunks still send and speaker audio still plays off the Chat page.
    audio.processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(4096) } });
    expect(JSON.parse(socket.sent.at(-1)!).type).toBe("audio");
    await act(async () => socket.receive({ type: "audio", data: "AAAAAA==" }));
    expect(audio.plays).toBe(1);
    transcript = "A reply received while browsing Activity.";
    await act(async () => socket.receive({ type: "turn_complete" }));
    await act(async () => { indicator()!.click(); });
    expect(container.textContent).toContain(transcript);
    expect(indicator()).toBeNull();
    expect(created).toBe(1);
    expect(sockets).toHaveLength(1);

    await click("Mute");
    await click("Activity");
    expect(indicator()?.getAttribute("aria-label")).toContain("Voice muted");
    await act(async () => { indicator()!.click(); });
    await click("Unmute");
    // The waveform and composer both offer End Voice.
    await click("End Voice");
    expect(socket.closed).toBe(true);
    expect(tracks[0]!.stopped).toBe(true);
    expect(audio.state).toBe("closed");
    await click("Activity");
    expect(indicator()).toBeNull();

    // A fresh app mount models reload: no route or conversation is restored.
    await act(async () => root.unmount());
    root = createRoot(container);
    transcript = "";
    await mount(width);
    expect(created).toBe(2);
    expect(container.querySelector("h1")?.textContent).toBe("New conversation");
  });
}

test("responsive frame changes retain the conversation and voice resources", async () => {
  await mount(1240);
  await click("Voice");
  await act(async () => sockets[0]!.receive({ type: "ready" }));
  await act(async () => browser.happyDOM.setWindowSize({ width: 390, height: 840 }));
  expect(container.querySelector('[data-frame="phone"]')).not.toBeNull();
  expect(created).toBe(1);
  expect(sockets[0]!.closed).toBe(false);
  await click("Activity");
  expect(indicator()).not.toBeNull();
  await act(async () => browser.happyDOM.setWindowSize({ width: 1240, height: 840 }));
  expect(created).toBe(1);
  expect(sockets[0]!.closed).toBe(false);
  await click("New");
  expect(created).toBe(2);
  expect(sockets[0]!.closed).toBe(true);
  expect(tracks[0]!.stopped).toBe(true);
});

test("pending microphone permission cannot revive a conversation after switching", async () => {
  let release!: (stream: unknown) => void;
  getMic = () => new Promise((resolve) => { release = resolve; });
  await mount(1240);
  await click("Voice");
  await click("New");
  const lateTrack = { stopped: false, stop() { this.stopped = true; } };
  await act(async () => release({ getTracks: () => [lateTrack] }));
  expect(lateTrack.stopped).toBe(true);
  expect(contexts[0]!.state).toBe("closed");
  expect(sockets).toHaveLength(0);
});

for (const width of [1240, 390]) {
  test(`an explicitly opened conversation survives page navigation at ${width}px`, async () => {
    await mount(width);
    if (width === 390) await click("← Conversations");
    await act(async () => { container.querySelector<HTMLElement>('[role="button"]')!.click(); });
    await click("Activity");
    await click("Chat");
    await click("Voice");
    expect(sockets[0]!.url).toContain("/old-chat/voice");
    expect(created).toBe(1);
    await act(async () => sockets[0]!.receive({ type: "ready" }));
    await click("Activity");
    await act(async () => sockets[0]!.receive({ type: "close", reason: "Session ended" }));
    expect(indicator()).toBeNull();
    expect(tracks[0]!.stopped).toBe(true);
    await click("Chat");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Session ended");
  });
}
