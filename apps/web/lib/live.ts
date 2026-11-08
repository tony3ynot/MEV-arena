/**
 * The real gateway: a WebSocket for GET /v1/stream and fetch() for the POST /v1/simulation/* endpoints.
 * Unused until apps/api exists (NEXT_PUBLIC_MOCK=0).
 */
import { parseSimulationState, type ReplayRequest } from "./contract";
import type { SimulationApi, Transport } from "./transport";

/** http://host:8000 -> ws://host:8000/v1/stream (https -> wss). Keeps any path prefix on the API URL. */
export function streamUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/v1/stream`;
}

export function liveTransport(apiUrl: string): Transport {
  return {
    open(handlers) {
      const ws = new WebSocket(streamUrl(apiUrl));
      ws.onopen = () => handlers.onOpen();
      ws.onmessage = (message) => handlers.onMessage(typeof message.data === "string" ? message.data : "");
      // An error event is always followed by a close event, which does the reporting.
      ws.onclose = (e) => handlers.onClose(`stream closed (code ${e.code}${e.reason ? `: ${e.reason}` : ""})`);
      return {
        close: () => {
          ws.onopen = null;
          ws.onmessage = null;
          ws.onclose = null;
          ws.close();
        },
      };
    },
  };
}

export function liveApi(apiUrl: string): SimulationApi {
  const base = apiUrl.replace(/\/+$/, "");
  const post = async (path: string, body?: ReplayRequest) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
    return parseSimulationState(await response.json());
  };
  return {
    pause: () => post("/v1/simulation/pause"),
    resume: () => post("/v1/simulation/resume"),
    step: () => post("/v1/simulation/step"),
    replay: (request) => post("/v1/simulation/replay", request),
  };
}
