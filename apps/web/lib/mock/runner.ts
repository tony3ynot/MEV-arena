/**
 * MockRunner: plays the gateway's part for the mock. It drives a MockSimulation on a timer and serves it
 * through the same Transport / SimulationApi interfaces as the real gateway (lib/transport.ts).
 *
 * Frames go out as JSON text, exactly like WebSocket messages, so the UI parses mock frames with the same
 * code (and the same checks) as real ones.
 */
import type { Frame, ReplayRequest, SimulationState, SimulationStatus } from "../contract";
import type { Connection, SimulationApi, Transport, TransportHandlers } from "../transport";
import { MOCK_DEFAULTS, MockSimulation } from "./sim";

const TICK_MS = 100;
/** Pretend network latency before the first frame of a new connection. */
const CONNECT_DELAY_MS = 80;

export class MockRunner implements Transport, SimulationApi {
  private sim: MockSimulation;
  private status: SimulationStatus = "running";
  private nextBlockAt: number | null = null;
  private intervalStart = 0;
  private arrivalsThisInterval = 0;
  private epoch = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<TransportHandlers>();
  private readonly clock: () => number;

  constructor(seed = MOCK_DEFAULTS.seed, policy = MOCK_DEFAULTS.policy, clock: () => number = () => Date.now()) {
    this.clock = clock;
    this.sim = new MockSimulation({ seed, policy, epoch: this.epoch, clock });
  }

  // ---- Transport ---------------------------------------------------------------------------------------

  open(handlers: TransportHandlers): Connection {
    this.startClock();
    let closed = false;
    const timer = setTimeout(() => {
      if (closed) return;
      this.listeners.add(handlers);
      handlers.onOpen();
      // Subscribe first, then snapshot: from here on this listener gets every frame (see SnapshotFrame).
      handlers.onMessage(JSON.stringify(this.sim.snapshot(this.state())));
    }, CONNECT_DELAY_MS);
    return {
      close: () => {
        closed = true;
        clearTimeout(timer);
        this.listeners.delete(handlers);
      },
    };
  }

  /** MOCK-ONLY test hook: cut every open stream, as a network failure would. The client should reconnect. */
  dropConnections(): void {
    const dropped = [...this.listeners];
    this.listeners.clear();
    for (const handlers of dropped) handlers.onClose("connection dropped by the mock (test button)");
  }

  // ---- SimulationApi -----------------------------------------------------------------------------------

  async pause(): Promise<SimulationState> {
    if (this.status === "running") {
      this.status = "paused";
      this.nextBlockAt = null;
      // Release the rest of this interval's submissions now, so the paused mempool shows what the next block will see.
      this.broadcast(this.sim.flushArrivals());
      this.broadcastState();
    }
    return this.state();
  }

  async resume(): Promise<SimulationState> {
    if (this.status === "paused") {
      this.status = "running";
      this.startInterval();
      this.broadcastState();
    }
    return this.state();
  }

  /** One block now. Only while paused; while running it changes nothing. */
  async step(): Promise<SimulationState> {
    if (this.status === "paused") {
      this.broadcast(this.sim.produceBlock());
      this.broadcast(this.sim.flushArrivals());
      this.broadcastState();
    }
    return this.state();
  }

  async replay({ policy, seed }: ReplayRequest): Promise<SimulationState> {
    this.epoch += 1;
    this.sim = new MockSimulation({ seed, policy, epoch: this.epoch, clock: this.clock });
    if (this.status === "running") this.startInterval();
    else this.sim.flushArrivals(); // the snapshot below carries them
    // All previous state is gone, so every stream gets a fresh snapshot rather than events.
    const snapshot = JSON.stringify(this.sim.snapshot(this.state()));
    for (const handlers of [...this.listeners]) handlers.onMessage(snapshot);
    return this.state();
  }

  // ---- clock -------------------------------------------------------------------------------------------

  private startClock(): void {
    if (this.ticker !== null) return;
    if (this.status === "running" && this.nextBlockAt === null) this.startInterval();
    this.ticker = setInterval(() => this.tick(), TICK_MS);
  }

  private startInterval(now = this.clock()): void {
    this.intervalStart = now;
    this.nextBlockAt = now + this.sim.blockIntervalMs;
    this.arrivalsThisInterval = this.sim.pendingArrivals;
  }

  private tick(): void {
    if (this.status !== "running" || this.nextBlockAt === null) return;
    const now = this.clock();
    // Spread this interval's submissions over the first 90 % of the interval.
    const total = this.arrivalsThisInterval;
    while (this.sim.pendingArrivals > 0) {
      const index = total - this.sim.pendingArrivals;
      const dueAt = this.intervalStart + ((index + 1) / (total + 1)) * this.sim.blockIntervalMs * 0.9;
      if (now < dueAt) break;
      this.broadcast(this.sim.emitNextArrival());
    }
    if (now >= this.nextBlockAt) {
      this.broadcast(this.sim.produceBlock());
      this.startInterval(now);
      this.broadcastState();
    }
  }

  // ---- output ------------------------------------------------------------------------------------------

  private state(): SimulationState {
    return this.sim.simulationState(this.status, this.nextBlockAt);
  }

  private broadcastState(): void {
    this.broadcast([{ kind: "simulation", state: this.state() }]);
  }

  private broadcast(frames: Frame[]): void {
    for (const frame of frames) {
      const text = JSON.stringify(frame);
      for (const handlers of [...this.listeners]) handlers.onMessage(text);
    }
  }
}
