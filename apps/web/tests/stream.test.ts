import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Frame, SnapshotFrame } from "../lib/contract";
import { initialState, reduce } from "../lib/reducer";
import type { ConnectionInfo } from "../lib/stream";

// lib/stream.ts reads NEXT_PUBLIC_MOCK when it loads, so set it first and import afterwards.
async function loadStream() {
  vi.stubEnv("NEXT_PUBLIC_MOCK", "1");
  vi.resetModules();
  return import("../lib/stream");
}

const snapshots = (frames: Frame[]) => frames.filter((f): f is SnapshotFrame => f.kind === "snapshot");

describe("stream (against the mock runner)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0); // no backoff jitter
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("starts with a snapshot, reconnects with backoff after a drop, and rebuilds from the new snapshot", async () => {
    const { connect, dropConnectionForTesting, MODE } = await loadStream();
    expect(MODE).toBe("mock");
    const frames: Frame[] = [];
    const statuses: ConnectionInfo[] = [];
    const stop = connect((f) => frames.push(f), (s) => statuses.push(s));

    await vi.advanceTimersByTimeAsync(100);
    expect(frames[0].kind).toBe("snapshot");
    expect(statuses.at(-1)?.state).toBe("open");

    await vi.advanceTimersByTimeAsync(6_100); // two blocks
    expect(frames.some((f) => f.kind === "event" && f.event.eventType === "BlockCommitted")).toBe(true);

    dropConnectionForTesting();
    expect(statuses.at(-1)).toMatchObject({ state: "reconnecting", attempt: 1, retryInMs: 500 });
    await vi.advanceTimersByTimeAsync(700); // 500 ms backoff + 80 ms connect
    expect(statuses.at(-1)?.state).toBe("open");
    const [first, second] = snapshots(frames);
    expect(second.simulation.height).toBeGreaterThan(first.simulation.height);

    // Feeding everything through the reducer ends in the state the second snapshot describes.
    const state = frames.reduce(reduce, initialState);
    expect(state.snapshots).toBe(2);
    expect(state.simulation?.height).toBe(second.simulation.height);
    stop();
  });

  it("pause, step and replay go through the same api and show up on the stream", async () => {
    const { connect, api } = await loadStream();
    const frames: Frame[] = [];
    const stop = connect((f) => frames.push(f));
    await vi.advanceTimersByTimeAsync(100);

    const paused = await api.pause();
    expect(paused).toMatchObject({ status: "paused", nextBlockAt: null });
    expect(frames.at(-1)).toMatchObject({ kind: "simulation", state: { status: "paused" } });

    const stepped = await api.step();
    expect(stepped.height).toBe(paused.height + 1);

    const replayed = await api.replay({ policy: "fifo", seed: 7 });
    expect(replayed).toMatchObject({ height: 0, policy: "fifo", seed: 7, status: "paused" });
    const last = snapshots(frames).at(-1)!;
    expect(last.simulation).toMatchObject({ height: 0, policy: "fifo", seed: 7 });
    expect(last.recentBlocks).toEqual([]);
    stop();
  });
});
