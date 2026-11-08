"use client";

import { POLICIES, type Policy, type SimulationState } from "../lib/contract";
import { policyLabel } from "../lib/format";
import type { ConnectionInfo } from "../lib/stream";
import { useNow } from "./hooks";
import { Button } from "./ui";

export function SafetyBanner() {
  return (
    <div role="note" className="sticky top-0 z-20 border-b border-line bg-raised px-4 py-1 text-center text-xs text-ink">
      <strong className="font-semibold">Simulation</strong> — no real assets, not investment advice.
    </div>
  );
}

interface HeaderProps {
  simulation: SimulationState | null;
  marketLabel: string;
  mode: "mock" | "live";
  connection: ConnectionInfo;
  /** Controls are usable: connected and synced, no request in flight. */
  ready: boolean;
  replayPolicy: Policy;
  onReplayPolicy: (policy: Policy) => void;
  onPause: () => void;
  onResume: () => void;
  onStep: () => void;
  onReplay: () => void;
  onDropConnection: (() => void) | null;
  error: string | null;
}

export function Header(props: HeaderProps) {
  const { simulation, ready } = props;
  const running = simulation?.status === "running";
  return (
    <header className="border-b border-line bg-surface px-4 py-2">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex items-baseline gap-2">
          <h1 className="text-base font-semibold">MEV Arena</h1>
          <span className="text-xs text-ink-2">{props.marketLabel}</span>
        </div>
        <Fact label="Height" value={simulation ? `#${simulation.height}` : "–"} />
        <Fact label="Status" value={simulation ? <StatusPill running={running} /> : "–"} />
        <Fact label="Policy" value={simulation ? policyLabel(simulation.policy) : "–"} />
        <Fact label="Seed" value={simulation ? String(simulation.seed) : "–"} />
        <Fact label="Capacity" value={simulation ? `${simulation.capacity} tx` : "–"} />
        <div className="ml-auto">
          <ConnectionBadge mode={props.mode} info={props.connection} onDrop={props.onDropConnection} />
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-56 flex-1">
          <Countdown simulation={simulation} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <Button onClick={props.onPause} disabled={!ready}>
              Pause
            </Button>
          ) : (
            <Button onClick={props.onResume} disabled={!ready || !simulation}>
              Resume
            </Button>
          )}
          <Button onClick={props.onStep} disabled={!ready || running} title={running ? "Pause first; Step builds one block" : "Build one block now"}>
            Step
          </Button>
          <label className="flex items-center gap-1.5 text-xs text-ink-2">
            Replay as
            <select
              value={props.replayPolicy}
              onChange={(e) => props.onReplayPolicy(e.target.value as Policy)}
              className="rounded border border-line bg-surface px-1.5 py-1 text-xs text-ink"
            >
              {POLICIES.map((p) => (
                <option key={p} value={p}>
                  {policyLabel(p)}
                  {p === "adversarial" && props.mode === "mock" ? " (placeholder)" : ""}
                </option>
              ))}
            </select>
          </label>
          <Button
            primary
            onClick={props.onReplay}
            disabled={!ready || !simulation}
            title="Re-run the same bot inputs from height 0 under the selected policy and the current seed"
          >
            Replay
          </Button>
        </div>
      </div>
      {props.error && (
        <p role="alert" className="mt-1 text-xs text-ink">
          <span aria-hidden className="text-critical">
            ✕
          </span>{" "}
          {props.error}
        </p>
      )}
    </header>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5 text-xs">
      <span className="text-ink-2">{label}</span>
      <span className="font-medium text-ink tabular-nums">{value}</span>
    </div>
  );
}

function StatusPill({ running }: { running: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={`size-2 rounded-full ${running ? "bg-good" : "bg-warning"}`} />
      {running ? "running" : "paused"}
    </span>
  );
}

/** Time to the next block as text and as a meter. The deadline comes from the server's clock. */
function Countdown({ simulation }: { simulation: SimulationState | null }) {
  const now = useNow(100);
  const due = simulation?.nextBlockAt ? Date.parse(simulation.nextBlockAt) : null;
  const interval = simulation?.blockIntervalMs ?? 3000;
  const remaining = due !== null && now > 0 ? Math.max(0, due - now) : null;
  const progress = remaining === null ? 0 : 1 - Math.min(1, remaining / interval);
  const text =
    simulation?.status === "paused" ? "paused · Step builds one block" : remaining === null ? "next block …" : `next block in ${(remaining / 1000).toFixed(1)} s`;
  return (
    <div className="flex items-center gap-3">
      <span className="w-48 shrink-0 text-xs text-ink-2 tabular-nums">{text}</span>
      <div
        role="progressbar"
        aria-label="Time until the next block"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-track"
      >
        <div className="h-full rounded-full bg-amm" style={{ width: `${(progress * 100).toFixed(1)}%` }} />
      </div>
    </div>
  );
}

function ConnectionBadge({ mode, info, onDrop }: { mode: "mock" | "live"; info: ConnectionInfo; onDrop: (() => void) | null }) {
  const tone = info.state === "open" ? "bg-good" : info.state === "connecting" ? "bg-warning" : "bg-critical";
  const label =
    info.state === "open"
      ? "connected"
      : info.state === "connecting"
        ? "connecting…"
        : `reconnecting${info.retryInMs !== null ? ` in ${(info.retryInMs / 1000).toFixed(1)} s` : "…"} (attempt ${info.attempt})`;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span role="status" aria-live="polite" className="inline-flex items-center gap-1.5">
        <span aria-hidden className={`size-2 rounded-full ${tone}`} />
        <span>
          {mode === "mock" ? "mock stream" : "live stream"} · {label}
        </span>
      </span>
      {info.state !== "open" && info.lastError && (
        <span className="max-w-64 truncate text-ink-2" title={info.lastError}>
          {info.lastError}
        </span>
      )}
      {onDrop && info.state === "open" && (
        <button
          type="button"
          onClick={onDrop}
          className="rounded border border-line px-1.5 py-0.5 text-ink-2 hover:bg-raised"
          title="Mock only: cut the stream to watch the reconnect and the snapshot rebuild"
        >
          drop connection
        </button>
      )}
    </div>
  );
}
