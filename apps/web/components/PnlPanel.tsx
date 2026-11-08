"use client";

import type { AccountKind } from "../lib/contract";
import { noiseSlippage, pnlByKind, pnlRows, summarizeRun, type RunSummary, type SlippageStats } from "../lib/derive";
import { formatAsset, formatBps, policyLabel } from "../lib/format";
import { MAX_BLOCKS, type ArenaState } from "../lib/reducer";
import { Account, KindDot, KindLabel, Panel } from "./ui";

/**
 * P&L per bot kind and per account (mark-to-market in quote at the current pool price, against start
 * balances), slippage paid by noise traders, and the runs kept from earlier replays.
 */
export function PnlPanel({ state, previousRuns }: { state: ArenaState; previousRuns: RunSummary[] }) {
  const quoteAsset = state.market?.quoteAsset ?? "QUOTE";
  const baseAsset = state.market?.baseAsset ?? "BASE";
  const rows = pnlRows(state).sort((a, b) => (a.pnl === b.pnl ? 0 : a.pnl > b.pnl ? -1 : 1));
  const kinds = pnlByKind(rows);
  const maxAbs = kinds.reduce((m, k) => (abs(k.pnl) > m ? abs(k.pnl) : m), 0n);
  const slippage = noiseSlippage(state);
  const current = summarizeRun(state);

  return (
    <Panel title="P&L and slippage" meta={`in ${quoteAsset}, at the pool price, vs start balances`}>
      <div className="flex flex-col gap-3 p-3">
        <table className="w-full text-xs tabular-nums">
          <caption className="sr-only">P&L by account kind</caption>
          <tbody>
            {kinds.map((k) => (
              <tr key={k.kind} className="border-b border-line last:border-b-0">
                <td className="py-1">
                  <KindLabel kind={k.kind} />
                  <span className="ml-1 text-ink-2">×{k.accounts}</span>
                </td>
                <td className="py-1 text-right font-medium">{formatAsset(k.pnl, quoteAsset, true)}</td>
                <td className="w-24 py-1 pl-3">
                  <PolarityBar value={k.pnl} maxAbs={maxAbs} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="grid grid-cols-2 gap-2">
          <SlippageTile label="Noise traders' slippage" stats={slippage.all} />
          <SlippageTile label="…when sandwiched" stats={slippage.sandwiched} />
        </div>
        <p className="-mt-1 text-[11px] text-ink-2">
          Executed noise swaps in the last {Math.min(state.blocks.length, MAX_BLOCKS)} blocks. Slippage is vs the pre-trade spot price and includes the 30 bps pool fee.
        </p>

        <details className="text-xs">
          <summary className="cursor-pointer text-ink-2 select-none">Per account ({rows.length})</summary>
          <div className="mt-1 max-h-56 overflow-auto">
            <table className="w-full tabular-nums">
              <thead className="sticky top-0 bg-surface text-left text-ink-2">
                <tr>
                  <th className="py-1 font-normal">Account</th>
                  <th className="py-1 text-right font-normal">Δ {baseAsset}</th>
                  <th className="py-1 text-right font-normal">Δ {quoteAsset}</th>
                  <th className="py-1 text-right font-normal">P&L</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.accountId} className="border-t border-line">
                    <td className="py-0.5">
                      <Account id={r.accountId} kind={r.kind} />
                    </td>
                    <td className="py-0.5 text-right">{formatAsset(r.baseDelta, baseAsset, true)}</td>
                    <td className="py-0.5 text-right">{formatAsset(r.quoteDelta, quoteAsset, true)}</td>
                    <td className="py-0.5 text-right font-medium">{formatAsset(r.pnl, quoteAsset, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>

        {current && <RunsTable current={current} previous={previousRuns} quoteAsset={quoteAsset} />}
      </div>
    </Panel>
  );
}

function abs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

/** A small bar from a center line: right for gains, left for losses. The signed number beside it carries the value. */
function PolarityBar({ value, maxAbs }: { value: bigint; maxAbs: bigint }) {
  const share = maxAbs === 0n ? 0 : Number((abs(value) * 1000n) / maxAbs) / 1000;
  const width = `${(share * 50).toFixed(1)}%`;
  return (
    <div className="relative h-2" aria-hidden>
      <div className="absolute inset-y-[-2px] left-1/2 w-px bg-axis" />
      {value > 0n && <div className="absolute inset-y-0 left-1/2 rounded-r-sm bg-pos" style={{ width }} />}
      {value < 0n && <div className="absolute inset-y-0 right-1/2 rounded-l-sm bg-neg" style={{ width }} />}
    </div>
  );
}

function SlippageTile({ label, stats }: { label: string; stats: SlippageStats }) {
  return (
    <div className="rounded border border-line px-2.5 py-2">
      <div className="text-[11px] text-ink-2">{label}</div>
      <div className="mt-0.5 text-sm font-semibold text-ink">
        {formatBps(stats.meanBps, 1)} <span className="text-[11px] font-normal text-ink-2">mean</span>
      </div>
      <div className="text-xs text-ink">
        {formatBps(stats.p95Bps)} <span className="text-ink-2">p95 · {stats.count} swaps</span>
      </div>
    </div>
  );
}

const RUN_KINDS: AccountKind[] = ["sandwich", "arb", "noise"];

/** The current run next to the ones kept from earlier replays, to compare policies on the same inputs. */
function RunsTable({ current, previous, quoteAsset }: { current: RunSummary; previous: RunSummary[]; quoteAsset: string }) {
  const runs = [{ run: current, now: true }, ...previous.map((run) => ({ run, now: false }))];
  return (
    <div className="text-xs">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="font-semibold tracking-wide text-ink uppercase">Runs</span>
        <span className="text-ink-2">P&L in {quoteAsset}; compare at similar heights</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full tabular-nums">
          <thead className="text-left text-ink-2">
            <tr>
              <th className="py-1 pr-2 font-normal">Policy</th>
              <th className="py-1 pr-2 text-right font-normal">Blocks</th>
              {RUN_KINDS.map((k) => (
                <th key={k} className="py-1 pr-2 text-right font-normal">
                  <span className="inline-flex items-center gap-1">
                    <KindDot kind={k} />
                    {k}
                  </span>
                </th>
              ))}
              <th className="py-1 pr-2 text-right font-normal" title="Noise traders' slippage, mean / p95 (bps)">
                slip
              </th>
              <th className="py-1 text-right font-normal" title="Sandwiches in the kept blocks">
                ▲
              </th>
            </tr>
          </thead>
          <tbody>
            {runs.map(({ run, now }, i) => (
              <tr key={i} className={`border-t border-line ${now ? "font-medium" : ""}`}>
                <td className="py-0.5 pr-2 whitespace-nowrap">
                  {policyLabel(run.policy)} <span className="font-normal text-ink-2">{now ? "(now)" : `seed ${run.seed}`}</span>
                </td>
                <td className="py-0.5 pr-2 text-right">{run.height}</td>
                {RUN_KINDS.map((k) => (
                  <td key={k} className="py-0.5 pr-2 text-right whitespace-nowrap">
                    {run.pnlByKind[k] === undefined ? "–" : formatAsset(run.pnlByKind[k], quoteAsset, true)}
                  </td>
                ))}
                <td className="py-0.5 pr-2 text-right whitespace-nowrap">
                  {run.noise.meanBps === null ? "–" : `${run.noise.meanBps.toFixed(0)} / ${run.noise.p95Bps}`}
                </td>
                <td className="py-0.5 text-right">{run.sandwiches}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {previous.length === 0 && <p className="mt-1 text-ink-2">Pick a policy and press Replay to add a comparison row.</p>}
    </div>
  );
}
