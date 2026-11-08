"use client";

/**
 * The page's root component: holds the reducer state, opens the stream, wires the controls.
 * All state changes from the server arrive as frames through `reduce` (lib/reducer.ts).
 */
import { useEffect, useReducer, useState } from "react";
import type { Policy } from "../lib/contract";
import { summarizeRun, type RunSummary } from "../lib/derive";
import { initialState, reduce } from "../lib/reducer";
import { MODE, api, connect, dropConnectionForTesting, type ConnectionInfo } from "../lib/stream";
import { BlocksPanel } from "./BlocksPanel";
import { Header, SafetyBanner } from "./Header";
import { MempoolPanel } from "./MempoolPanel";
import { PnlPanel } from "./PnlPanel";
import { PriceChart } from "./PriceChart";

const MAX_KEPT_RUNS = 5;

export function Arena() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [connection, setConnection] = useState<ConnectionInfo>({ state: "connecting", attempt: 0, retryInMs: null, lastError: null });
  const [selectedHeight, setSelectedHeight] = useState<number | null>(null);
  const [replayChoice, setReplayChoice] = useState<Policy | null>(null);
  const [previousRuns, setPreviousRuns] = useState<RunSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Open the stream once; the returned function closes it when the page goes away.
  useEffect(() => connect(dispatch, setConnection), []);

  const simulation = state.simulation;
  const replayPolicy: Policy = replayChoice ?? simulation?.policy ?? "priority_fee";
  const live = connection.state === "open" && state.synced;

  const call = async (label: string, request: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await request();
    } catch (e) {
      setError(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onReplay = () => {
    if (!simulation) return;
    const summary = summarizeRun(state);
    if (summary && summary.height > 0) setPreviousRuns((runs) => [summary, ...runs].slice(0, MAX_KEPT_RUNS));
    setSelectedHeight(null);
    void call("Replay", () => api.replay({ policy: replayPolicy, seed: simulation.seed }));
  };

  const market = state.market;
  return (
    <div className="min-h-screen">
      <SafetyBanner />
      <Header
        simulation={simulation}
        marketLabel={market ? `${market.baseAsset}/${market.quoteAsset} · fee ${market.feeBps} bps` : ""}
        mode={MODE}
        connection={connection}
        ready={live && !busy}
        replayPolicy={replayPolicy}
        onReplayPolicy={setReplayChoice}
        onPause={() => void call("Pause", api.pause)}
        onResume={() => void call("Resume", api.resume)}
        onStep={() => void call("Step", api.step)}
        onReplay={onReplay}
        onDropConnection={MODE === "mock" ? dropConnectionForTesting : null}
        error={error}
      />

      {!state.synced ? (
        <p className="p-8 text-center text-sm text-ink-2">Waiting for the first snapshot…</p>
      ) : (
        // While disconnected, keep showing the last state, dimmed, until the next snapshot replaces it.
        <main
          aria-busy={!live}
          className={`mx-auto grid max-w-[1600px] grid-cols-1 gap-3 p-3 transition-opacity lg:grid-cols-12 ${live ? "" : "opacity-60"}`}
        >
          <div className="min-w-0 lg:col-span-7">
            <PriceChart points={state.prices} baseAsset={market?.baseAsset ?? "BASE"} quoteAsset={market?.quoteAsset ?? "QUOTE"} />
          </div>
          <div className="min-w-0 lg:col-span-5">
            <MempoolPanel state={state} />
          </div>
          <div className="min-w-0 lg:col-span-7">
            <BlocksPanel state={state} selectedHeight={selectedHeight} onSelect={setSelectedHeight} />
          </div>
          <div className="min-w-0 lg:col-span-5">
            <PnlPanel state={state} previousRuns={previousRuns} />
          </div>
        </main>
      )}
    </div>
  );
}
