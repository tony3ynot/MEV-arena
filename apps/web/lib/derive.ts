/**
 * Numbers the panels show, computed from reducer state. Pure functions; BigInt until the very end.
 */
import { ACCOUNT_KINDS, SCALE, toBigInt, type AccountKind, type Receipt, type Side, type Tx } from "./contract";
import type { AccountState, ArenaState } from "./reducer";

/** An account's kind from the snapshot's account list, or from its `${kind}-${n}` id. */
export function kindOf(accounts: Record<string, AccountState>, accountId: string): AccountKind {
  const known = accounts[accountId]?.info.kind;
  if (known) return known;
  const prefix = accountId.split("-")[0] as AccountKind;
  return ACCOUNT_KINDS.includes(prefix) ? prefix : "user";
}

// ---- P&L -----------------------------------------------------------------------------------------------

export interface PnlRow {
  accountId: string;
  kind: AccountKind;
  baseDelta: bigint;
  quoteDelta: bigint;
  /** In quote minimal units. */
  pnl: bigint;
}

/**
 * Mark-to-market P&L in quote, relative to the start balances: what the account holds now minus what it
 * started with, both valued at the current pool price. Price moves alone therefore do not count as P&L;
 * only trading does.
 */
export function pnlRows(state: ArenaState): PnlRow[] {
  if (!state.market) return [];
  const price = toBigInt(state.market.price);
  return Object.values(state.accounts).map((a) => {
    const baseDelta = a.base - toBigInt(a.info.startBase);
    const quoteDelta = a.quote - toBigInt(a.info.startQuote);
    return { accountId: a.info.accountId, kind: a.info.kind, baseDelta, quoteDelta, pnl: (baseDelta * price) / SCALE + quoteDelta };
  });
}

export interface KindPnl {
  kind: AccountKind;
  accounts: number;
  pnl: bigint;
}

export function pnlByKind(rows: PnlRow[]): KindPnl[] {
  return ACCOUNT_KINDS.map((kind) => {
    const mine = rows.filter((r) => r.kind === kind);
    return { kind, accounts: mine.length, pnl: mine.reduce((sum, r) => sum + r.pnl, 0n) };
  }).filter((k) => k.accounts > 0);
}

// ---- slippage ------------------------------------------------------------------------------------------

export interface SlippageStats {
  count: number;
  meanBps: number | null;
  p95Bps: number | null;
}

/** Mean and 95th percentile (nearest rank) of a list of bps values. */
export function slippageStats(values: number[]): SlippageStats {
  if (values.length === 0) return { count: 0, meanBps: null, p95Bps: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1];
  return { count: sorted.length, meanBps: mean, p95Bps: p95 };
}

/** Slippage of noise traders' executed swaps over the kept blocks: all of them, and the sandwiched ones. */
export function noiseSlippage(state: ArenaState): { all: SlippageStats; sandwiched: SlippageStats } {
  const all: number[] = [];
  const sandwiched: number[] = [];
  for (const block of state.blocks) {
    const tags = blockSandwiches(block.receipts, (id) => kindOf(state.accounts, id));
    for (const r of block.receipts) {
      if (r.status !== "executed" || kindOf(state.accounts, r.accountId) !== "noise") continue;
      all.push(r.slippageBps);
      if (tags.get(r.transactionId)?.role === "victim") sandwiched.push(r.slippageBps);
    }
  }
  return { all: slippageStats(all), sandwiched: slippageStats(sandwiched) };
}

// ---- sandwich detection --------------------------------------------------------------------------------

export type SandwichRole = "front" | "victim" | "back";

export interface SandwichTag {
  role: SandwichRole;
  /** Which sandwich in this block or mempool, 0 first. */
  group: number;
}

const opposite = (side: Side): Side => (side === "buy" ? "sell" : "buy");

/**
 * Sandwiches in an executed block: a sandwich-bot swap, later the same bot's swap the other way, and in
 * between at least one other account's swap on the front's side (the victim). Only executed swaps count;
 * a front landing after its victim (as FIFO tends to do) is not a sandwich.
 */
export function blockSandwiches(receipts: Receipt[], kind: (accountId: string) => AccountKind): Map<string, SandwichTag> {
  const tags = new Map<string, SandwichTag>();
  const rows = [...receipts].sort((a, b) => a.position - b.position).filter((r) => r.status === "executed");
  let group = 0;
  rows.forEach((front, i) => {
    if (kind(front.accountId) !== "sandwich" || tags.has(front.transactionId)) return;
    const j = rows.findIndex((r, k) => k > i && r.accountId === front.accountId && r.side === opposite(front.side));
    if (j < 0) return;
    const victims = rows.slice(i + 1, j).filter((r) => kind(r.accountId) !== "sandwich" && r.side === front.side);
    if (victims.length === 0) return;
    tags.set(front.transactionId, { role: "front", group });
    for (const v of victims) tags.set(v.transactionId, { role: "victim", group });
    tags.set(rows[j].transactionId, { role: "back", group });
    group += 1;
  });
  return tags;
}

/**
 * Sandwiches still pending: a sandwich-bot transaction with nonce n and the same bot's opposite-side
 * transaction with nonce n + 1. The likely victim is the latest other transaction on the front's side that
 * arrived before the front. An inference: the stream does not say who the target is.
 */
export function mempoolSandwiches(mempool: Tx[], kind: (accountId: string) => AccountKind): Map<string, SandwichTag> {
  const tags = new Map<string, SandwichTag>();
  let group = 0;
  mempool.forEach((front, frontIndex) => {
    if (kind(front.accountId) !== "sandwich") return;
    const back = mempool.find((t) => t.accountId === front.accountId && t.nonce === front.nonce + 1 && t.side === opposite(front.side));
    if (!back) return;
    let victim: Tx | undefined;
    for (let i = frontIndex - 1; i >= 0 && !victim; i--) {
      const t = mempool[i];
      if (kind(t.accountId) !== "sandwich" && t.side === front.side) victim = t;
    }
    tags.set(front.id, { role: "front", group });
    tags.set(back.id, { role: "back", group });
    if (victim) tags.set(victim.id, { role: "victim", group });
    group += 1;
  });
  return tags;
}

/** Number of sandwiches over the kept blocks. */
export function sandwichCount(state: ArenaState): number {
  let count = 0;
  for (const block of state.blocks) {
    const tags = blockSandwiches(block.receipts, (id) => kindOf(state.accounts, id));
    for (const tag of tags.values()) if (tag.role === "front") count += 1;
  }
  return count;
}

// ---- run comparison ------------------------------------------------------------------------------------

/** A run's headline numbers, kept when the user replays so policies can be compared (spec §4 steps 7-8). */
export interface RunSummary {
  policy: string;
  seed: number;
  height: number;
  pnlByKind: Partial<Record<AccountKind, bigint>>;
  noise: SlippageStats;
  sandwiches: number;
}

export function summarizeRun(state: ArenaState): RunSummary | null {
  if (!state.simulation) return null;
  const pnlByKindMap: Partial<Record<AccountKind, bigint>> = {};
  for (const k of pnlByKind(pnlRows(state))) pnlByKindMap[k.kind] = k.pnl;
  return {
    policy: state.simulation.policy,
    seed: state.simulation.seed,
    height: state.simulation.height,
    pnlByKind: pnlByKindMap,
    noise: noiseSlippage(state).all,
    sandwiches: sandwichCount(state),
  };
}
