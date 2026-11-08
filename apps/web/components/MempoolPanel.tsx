"use client";

import type { RejectReason } from "../lib/contract";
import { kindOf, mempoolSandwiches, type SandwichTag } from "../lib/derive";
import { assetsFor, formatAsset } from "../lib/format";
import type { ArenaState } from "../lib/reducer";
import { Account, Panel } from "./ui";

/** Live mempool in arrival order. Sandwich-bot transactions and their likely victim are marked. */
export function MempoolPanel({ state }: { state: ArenaState }) {
  const { mempool, market, simulation, accounts, rejections } = state;
  const kind = (id: string) => kindOf(accounts, id);
  const tags = mempoolSandwiches(mempool, kind);
  const height = simulation?.height ?? 0;
  const baseAsset = market?.baseAsset ?? "BASE";
  const quoteAsset = market?.quoteAsset ?? "QUOTE";

  return (
    <Panel
      className="h-full"
      title="Mempool"
      meta={`${mempool.length} pending · arrival order`}
      actions={<RejectionSummary total={rejections.total} byReason={rejections.byReason} />}
    >
      {/* On wide screens the list fills the row next to the chart and scrolls inside it. */}
      <div className="max-h-[360px] overflow-auto lg:absolute lg:inset-0 lg:max-h-none">
        <table className="w-full text-xs tabular-nums">
          <thead className="sticky top-0 z-10 bg-surface text-left text-ink-2">
            <tr className="border-b border-line">
              <th className="px-2 py-1 font-normal">#</th>
              <th className="px-2 py-1 font-normal" title="Blocks since submission">
                Age
              </th>
              <th className="px-2 py-1 font-normal">Account</th>
              <th className="px-2 py-1 font-normal">Side</th>
              <th className="px-2 py-1 text-right font-normal">Amount in</th>
              <th className="px-2 py-1 text-right font-normal" title="Virtual priority fee">
                Fee
              </th>
              <th className="hidden px-2 py-1 text-right font-normal sm:table-cell">Nonce</th>
              <th className="px-2 py-1 font-normal">MEV</th>
            </tr>
          </thead>
          <tbody>
            {mempool.length === 0 && (
              <tr>
                <td colSpan={8} className="px-2 py-6 text-center text-ink-2">
                  Empty. New transactions appear here as they arrive.
                </td>
              </tr>
            )}
            {mempool.map((tx, i) => {
              const tag = tags.get(tx.id);
              const { assetIn, assetOut } = assetsFor(tx.side, baseAsset, quoteAsset);
              const age = Math.max(0, height - tx.submittedAt);
              return (
                <tr
                  key={tx.id}
                  className={`border-b border-line last:border-b-0 ${tag ? (tag.role === "victim" ? "bg-kind-sandwich/5" : "bg-kind-sandwich/10") : ""}`}
                  title={`${tx.id} · key ${tx.idempotencyKey} · min out ${formatAsset(tx.minAmountOut, assetOut)} ${assetOut} · last block #${tx.expiresAt}`}
                >
                  <td className="px-2 py-1 text-ink-2">{i + 1}</td>
                  <td className="px-2 py-1">{age === 0 ? "new" : `${age} blk`}</td>
                  <td className="px-2 py-1">
                    <Account id={tx.accountId} kind={kind(tx.accountId)} />
                  </td>
                  <td className="px-2 py-1">{tx.side}</td>
                  <td className="px-2 py-1 text-right whitespace-nowrap">
                    {formatAsset(tx.amountIn, assetIn)} <span className="text-ink-2">{assetIn}</span>
                  </td>
                  <td className="px-2 py-1 text-right">{tx.priorityFee}</td>
                  <td className="hidden px-2 py-1 text-right sm:table-cell">{tx.nonce}</td>
                  <td className="px-2 py-1">{tag && <SandwichChip tag={tag} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

const ROLE_MARK: Record<SandwichTag["role"], string> = { front: "▲", victim: "●", back: "▼" };

/** "▲ front S1": role in words; S-number links the three transactions of one sandwich. */
export function SandwichChip({ tag }: { tag: SandwichTag }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span aria-hidden className="text-kind-sandwich">
        {ROLE_MARK[tag.role]}
      </span>
      <span className="text-ink">{tag.role}</span>
      <span className="text-ink-2">S{tag.group + 1}</span>
    </span>
  );
}

function RejectionSummary({ total, byReason }: { total: number; byReason: Partial<Record<RejectReason, number>> }) {
  if (total === 0) return <span className="text-xs text-ink-2">0 rejected</span>;
  const parts = Object.entries(byReason).map(([reason, n]) => `${reason} ${n}`);
  return (
    <span className="text-xs text-ink-2" title="TransactionRejected since this snapshot">
      {total} rejected ({parts.join(", ")})
    </span>
  );
}
