/**
 * The one place that chooses between the in-browser mock and the real gateway. Everything else in the UI
 * talks to `connect` (the stream) and `api` (the controls) and never knows which one it got.
 *
 *   NEXT_PUBLIC_MOCK=1      -> lib/mock/runner.ts (the default in .env.development for now)
 *   otherwise               -> lib/live.ts against NEXT_PUBLIC_API_URL (default http://localhost:8000)
 *
 * Next.js copies NEXT_PUBLIC_* values into the browser bundle at build time, so changing them needs a
 * restart of `npm run dev` or a new `npm run build`.
 */
import { parseFrame, type Frame, type ReplayRequest } from "./contract";
import { liveApi, liveTransport } from "./live";
import { MockRunner } from "./mock/runner";
import type { SimulationApi, Transport } from "./transport";

export const MODE: "mock" | "live" = process.env.NEXT_PUBLIC_MOCK === "1" ? "mock" : "live";
export const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

interface Backend {
  transport: Transport;
  api: SimulationApi;
  /** MOCK-ONLY: cut the stream to exercise reconnects. */
  dropConnection: (() => void) | null;
}

let backend: Backend | null = null;

/** Created on first use, in the browser, so the mock's timers never start during server rendering. */
function getBackend(): Backend {
  if (backend === null) {
    if (MODE === "mock") {
      const runner = new MockRunner();
      backend = { transport: runner, api: runner, dropConnection: () => runner.dropConnections() };
    } else {
      backend = { transport: liveTransport(API_URL), api: liveApi(API_URL), dropConnection: null };
    }
  }
  return backend;
}

export const api: SimulationApi = {
  pause: () => getBackend().api.pause(),
  resume: () => getBackend().api.resume(),
  step: () => getBackend().api.step(),
  replay: (request: ReplayRequest) => getBackend().api.replay(request),
};

/** MOCK-ONLY: drop the stream so the reconnect path can be watched. No-op against the real gateway. */
export function dropConnectionForTesting(): void {
  getBackend().dropConnection?.();
}

export type ConnectionState = "connecting" | "open" | "reconnecting";

export interface ConnectionInfo {
  state: ConnectionState;
  /** Failed attempts in a row; 0 once a snapshot arrives. */
  attempt: number;
  /** While reconnecting: the wait before the next attempt. */
  retryInMs: number | null;
  lastError: string | null;
}

/** 0.5 s, 1 s, 2 s, 4 s, 8 s, then 10 s, each plus up to 20 % jitter so many clients do not retry in step. */
export function backoffMs(attempt: number): number {
  const base = Math.min(10_000, 500 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (1 + Math.random() * 0.2));
}

/**
 * Open the stream and keep it open. Every frame is parsed and checked (lib/contract.ts) before `onFrame`
 * sees it. When the connection drops, it retries with backoff; the server starts every connection with a
 * snapshot, and the reducer rebuilds all state from it. Returns a function that closes the stream for good.
 */
export function connect(onFrame: (frame: Frame) => void, onStatus: (info: ConnectionInfo) => void = () => {}): () => void {
  const transport = getBackend().transport;
  let stopped = false;
  let attempt = 0;
  let lastError: string | null = null;
  let current: { close(): void } | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    retryTimer = null;
    let finished = false; // this connection is over; ignore anything else it says
    onStatus({ state: attempt === 0 ? "connecting" : "reconnecting", attempt, retryInMs: null, lastError });

    const retry = (reason: string) => {
      if (finished || stopped) return;
      finished = true;
      current?.close();
      current = null;
      lastError = reason;
      attempt += 1;
      const delay = backoffMs(attempt);
      onStatus({ state: "reconnecting", attempt, retryInMs: delay, lastError });
      retryTimer = setTimeout(open, delay);
    };

    current = transport.open({
      onOpen: () => {
        if (!finished) onStatus({ state: "open", attempt, retryInMs: null, lastError });
      },
      onMessage: (text) => {
        if (finished) return;
        let frame: Frame;
        try {
          frame = parseFrame(text);
        } catch (error) {
          // After a frame we cannot read, our state may be wrong: start over from a fresh snapshot.
          console.error("MEV Arena: bad frame, reconnecting", error, text.slice(0, 500));
          retry(`bad frame: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        if (frame.kind === "snapshot") {
          attempt = 0;
          lastError = null;
        }
        onFrame(frame);
      },
      onClose: (reason) => retry(reason),
    });
  };

  open();
  return () => {
    stopped = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
    current?.close();
    current = null;
  };
}
