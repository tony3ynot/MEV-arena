/**
 * The two things a backend provides, whether it is the real gateway (lib/live.ts) or the in-browser mock
 * (lib/mock/runner.ts). lib/stream.ts picks one and adds reconnects on top.
 */
import type { ReplayRequest, SimulationState } from "./contract";

export interface TransportHandlers {
  onOpen(): void;
  /** One raw JSON text frame, exactly as a WebSocket message would carry it. */
  onMessage(text: string): void;
  /** The connection went away on its own. Never called after the client itself called close(). */
  onClose(reason: string): void;
}

export interface Connection {
  close(): void;
}

/** GET /v1/stream */
export interface Transport {
  open(handlers: TransportHandlers): Connection;
}

/** POST /v1/simulation/{pause|resume|step|replay}; each resolves to the new SimulationState. */
export interface SimulationApi {
  pause(): Promise<SimulationState>;
  resume(): Promise<SimulationState>;
  step(): Promise<SimulationState>;
  replay(request: ReplayRequest): Promise<SimulationState>;
}
