"use client";

import type { AccountKind, BlockSummary } from "../lib/contract";
import { blockSandwiches, kindOf, type SandwichTag } from "../lib/derive";
import { assetsFor, formatAsset, policyLabel, shortHash } from "../lib/format";
import type { ArenaState } from "../lib/reducer";
import { SandwichChip } from "./MempoolPanel";
import { Account, Panel, TxStatusLabel } from "./ui";

/**
 * The recent blocks as a strip of buttons, and one block's transactions in execution order (the latest
 * unless the user picked one). A sandwich (front -> victim -> back) is joined by a bracket in the first column.
 */
export function BlocksPanel({
  state,
  selectedHeight,
  onSelect,
}: {
  state: ArenaState;
  /** null = follow the latest block. */
  selectedHeight: number | null;
  onSelect: (height: number | null) => void;
}) {
  const { blocks, accounts, market } = state;
  const kind = (id: string) => kindOf(accounts, id);
  const latest = blocks.at(-1);
  const block = (selectedHeight !== null ? blocks.find((b) => b.height === selectedHeight) : undefined) ?? latest;
  const following = selectedHeight === null || block === latest;

  return (
    <Panel
      title={block ? `Block #${block.height}` : "Blocks"}
      meta={
        block && (
          <span className="tabular-nums">
            {policyLabel(block.policy)} · {block.executed} executed · {block.failed} failed ·{" "}
            <span className="font-mono" title={`state root ${block.stateRoot}`}>
              root {shortHash(block.stateRoot)}
            </span>
          </span>
        )
      }
      actions={
        !following && (
          <button type="button" onClick={() => onSelect(null)} className="rounded border border-line px-1.5 py-0.5 text-xs text-ink-2 hover:bg-raised">
            follow latest
          </button>
        )
      }
    >
      <RecentBlocks blocks={blocks} selected={block?.height ?? null} kind={kind} onSelect={(h) => onSelect(h === latest?.height ? null : h)} />
      <div className="max-h-[440px] min-w-0 overflow-auto">
        {block ? (
          <BlockTable block={block} kind={kind} baseAsset={market?.baseAsset ?? "BASE"} quoteAsset={market?.quoteAsset ?? "QUOTE"} />
        ) : (
          <p className="px-3 py-6 text-center text-xs text-ink-2">No block yet. The first one is built when the countdown ends.</p>
        )}
      </div>
    </Panel>
  );
}

function BlockTable({
  block,
  kind,
  baseAsset,
  quoteAsset,
}: {
  block: BlockSummary;
  kind: (id: string) => AccountKind;
  baseAsset: string;
  quoteAsset: string;
}) {
  const receipts = [...block.receipts].sort((a, b) => a.position - b.position);
  const tags = blockSandwiches(receipts, kind);
  // Each sandwich's span of positions, front to back, for the bracket.
  const spans: { from: number; to: number }[] = [];
  for (const r of receipts) {
    const tag = tags.get(r.transactionId);
    if (!tag) continue;
    const span = (spans[tag.group] ??= { from: r.position, to: r.position });
    span.from = Math.min(span.from, r.position);
    span.to = Math.max(span.to, r.position);
  }

  if (receipts.length === 0) return <p className="px-3 py-6 text-center text-xs text-ink-2">Empty block.</p>;

  return (
    <table className="w-full text-xs tabular-nums">
      <thead className="sticky top-0 z-10 bg-surface text-left text-ink-2">
        <tr className="border-b border-line">
          <th className="w-4 p-0" aria-label="Sandwich link" />
          <th className="px-2 py-1 font-normal">Pos</th>
          <th className="px-2 py-1 font-normal">Account</th>
          <th className="px-2 py-1 font-normal">Side</th>
          <th className="px-2 py-1 text-right font-normal">In</th>
          <th className="px-2 py-1 text-right font-normal">Out</th>
          <th className="px-2 py-1 text-right font-normal" title="Slippage vs the pre-trade spot price, floored">
            Slip
          </th>
          <th className="px-2 py-1 font-normal">Result</th>
          <th className="px-2 py-1 font-normal">MEV</th>
        </tr>
      </thead>
      <tbody>
        {receipts.map((r) => {
          const tag = tags.get(r.transactionId);
          const span = spans.find((s) => s.from <= r.position && r.position <= s.to);
          const { assetIn, assetOut } = assetsFor(r.side, baseAsset, quoteAsset);
          return (
            <tr key={r.transactionId} className={`border-b border-line last:border-b-0 ${tag?.role === "victim" ? "bg-kind-sandwich/10" : ""}`} title={r.transactionId}>
              <td className="relative w-4 p-0" aria-hidden>
                {span && <Bracket from={span.from} to={span.to} position={r.position} tag={tag} />}
              </td>
              <td className="px-2 py-1 text-ink-2">{r.position}</td>
              <td className="px-2 py-1">
                <Account id={r.accountId} kind={kind(r.accountId)} />
              </td>
              <td className="px-2 py-1">{r.side}</td>
              <td className="px-2 py-1 text-right whitespace-nowrap">
                {formatAsset(r.amountIn, assetIn)} <span className="text-ink-2">{assetIn}</span>
              </td>
              <td className="px-2 py-1 text-right whitespace-nowrap">
                {r.status === "executed" ? (
                  <>
                    {formatAsset(r.amountOut, assetOut)} <span className="text-ink-2">{assetOut}</span>
                  </>
                ) : (
                  <span className="text-ink-2">–</span>
                )}
              </td>
              <td className="px-2 py-1 text-right">{r.status === "executed" ? r.slippageBps : "–"}</td>
              <td className="px-2 py-1">
                <TxStatusLabel status={r.status} errorCode={r.errorCode} />
              </td>
              <td className="px-2 py-1">{tag && <SandwichChip tag={tag} />}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** One row's piece of the vertical bracket that joins a sandwich's front, victim(s) and back. */
function Bracket({ from, to, position, tag }: { from: number; to: number; position: number; tag: SandwichTag | undefined }) {
  const top = position === from ? "top-1/2" : "top-0";
  const bottom = position === to ? "bottom-1/2" : "bottom-0";
  return (
    <>
      <span className={`absolute left-1/2 w-0.5 -translate-x-1/2 bg-kind-sandwich ${top} ${bottom}`} />
      {tag && (
        <span
          className={`absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface ${tag.role === "victim" ? "bg-surface outline-2 outline-kind-sandwich" : "bg-kind-sandwich"}`}
        />
      )}
    </>
  );
}

function RecentBlocks({
  blocks,
  selected,
  kind,
  onSelect,
}: {
  blocks: BlockSummary[];
  selected: number | null;
  kind: (id: string) => AccountKind;
  onSelect: (height: number) => void;
}) {
  if (blocks.length === 0) return null;
  return (
    <nav aria-label="Recent blocks, newest first" className="border-b border-line">
      <ul className="flex gap-1 overflow-x-auto px-2 py-1.5 text-xs tabular-nums">
        {[...blocks].reverse().map((b) => {
          const sandwiches = [...blockSandwiches(b.receipts, kind).values()].filter((t) => t.role === "front").length;
          const isSelected = b.height === selected;
          return (
            <li key={b.height} className="shrink-0">
              <button
                type="button"
                onClick={() => onSelect(b.height)}
                aria-current={isSelected ? "true" : undefined}
                title={`${b.executed} executed, ${b.failed} failed${sandwiches ? `, ${sandwiches} sandwich${sandwiches > 1 ? "es" : ""}` : ""}`}
                className={`flex items-baseline gap-1.5 rounded border px-1.5 py-0.5 hover:bg-raised ${isSelected ? "border-amm bg-raised" : "border-line"}`}
              >
                <span className="font-medium text-ink">#{b.height}</span>
                <span className="text-ink-2">
                  {b.executed}✓{b.failed > 0 ? ` ${b.failed}✕` : ""}
                </span>
                {sandwiches > 0 && (
                  <span className="inline-flex items-baseline gap-0.5 text-ink-2">
                    <span aria-hidden className="text-kind-sandwich">
                      ▲
                    </span>
                    {sandwiches}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
