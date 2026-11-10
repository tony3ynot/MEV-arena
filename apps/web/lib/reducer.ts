/**
 * The single reducer: (UI state, one frame) -> new UI state. Pure, no I/O, no clocks; unit-tested in
 * tests/reducer.test.ts.
 *
 * Rules
 * - A snapshot replaces everything. Nothing from before it is merged in, so a reconnect or a replay can
 *   never leave stale state behind.
 * - Events are applied only after the first snapshot, at most once per eventId (delivery is at-least-once).
 * - Block events at or below the snapshot height are already in the snapshot and are dropped.
 */
import {
  SCALE,
  toBigInt,
  type AccountInfo,
  type BlockCommitted,
  type BlockProposed,
  type BlockSummary,
  type DecimalString,
  type Envelope,
  type Frame,
  type Market,
  type MarketPriceUpdated,
  type Policy,
  type Receipt,
  type RejectReason,
  type SimulationState,
  type SnapshotFrame,
  type SwapExecuted,
  type TransactionAccepted,
  type TransactionDropped,
  type TransactionExecuted,
  type TransactionRejected,
  type Tx,
} from "./contract";

/** Blocks kept for the block list, the chart and the slippage stats. */
export const MAX_BLOCKS = 100;
const MAX_SEEN_EVENTS = 2_000;
const MAX_RECENT_REJECTIONS = 20;

export interface AccountState {
  info: AccountInfo;
  /** Current balances in minimal units. */
  base: bigint;
  quote: bigint;
}

/** The pool price right after the block at `height`. */
export interface PricePoint {
  height: number;
  price: DecimalString;
  referencePrice: DecimalString | null;
}

/** The block whose events are arriving right now (between BlockProposed and BlockCommitted). */
export interface BlockInProgress {
  height: number;
  policy: Policy;
  receipts: Receipt[];
}

export interface Rejections {
  total: number;
  byReason: Partial<Record<RejectReason, number>>;
  recent: TransactionRejected[];
}

export interface ArenaState {
  /** False until the first snapshot. Nothing else is meaningful before that. */
  synced: boolean;
  /** Snapshots applied so far: 1 after the first connect, more after reconnects and replays. */
  snapshots: number;
  simulation: SimulationState | null;
  market: Market | null;
  /** Pending transactions in arrival order. */
  mempool: Tx[];
  building: BlockInProgress | null;
  /** Committed blocks, ascending by height, at most MAX_BLOCKS. */
  blocks: BlockSummary[];
  accounts: Record<string, AccountState>;
  /** One point per block in `blocks`, plus the price before the oldest one. */
  prices: PricePoint[];
  /** Counted since the last snapshot. */
  rejections: Rejections;
  seenEventIds: string[];
}

export const initialState: ArenaState = {
  synced: false,
  snapshots: 0,
  simulation: null,
  market: null,
  mempool: [],
  building: null,
  blocks: [],
  accounts: {},
  prices: [],
  rejections: { total: 0, byReason: {}, recent: [] },
  seenEventIds: [],
};

export function reduce(state: ArenaState, frame: Frame): ArenaState {
  switch (frame.kind) {
    case "snapshot":
      return fromSnapshot(frame, state.snapshots + 1);
    case "simulation":
      return state.synced ? { ...state, simulation: frame.state } : state;
    case "event":
      return applyEvent(state, frame.event);
  }
}

// ---- snapshot ------------------------------------------------------------------------------------------

/** Build the whole UI state from one snapshot. Deliberately takes nothing from the previous state. */
export function fromSnapshot(frame: SnapshotFrame, snapshots = 1): ArenaState {
  const blocks = [...frame.recentBlocks].sort((a, b) => a.height - b.height).slice(-MAX_BLOCKS);
  const accounts: Record<string, AccountState> = {};
  for (const info of frame.accounts) {
    accounts[info.accountId] = { info, base: toBigInt(info.baseBalance), quote: toBigInt(info.quoteBalance) };
  }
  return {
    synced: true,
    snapshots,
    simulation: frame.simulation,
    market: frame.market,
    mempool: [...frame.mempool],
    building: null,
    blocks,
    accounts,
    prices: reconstructPrices(frame.market, blocks, frame.simulation.height),
    rejections: { total: 0, byReason: {}, recent: [] },
    seenEventIds: [],
  };
}

/**
 * The snapshot carries no price history, but reserves only ever change through swaps, and every swap is in
 * a block receipt. Starting from the current reserves and undoing each block's executed swaps, newest
 * first, gives the exact price after every recent block. Integer math, so it matches the live events to the
 * unit. Assumes the single v0.1 market (receipts carry no marketId).
 */
export function reconstructPrices(market: Market, blocks: BlockSummary[], height: number): PricePoint[] {
  const referenceNow = market.referencePrice ?? null;
  if (blocks.length === 0) return [{ height, price: market.price, referencePrice: referenceNow }];

  let base = toBigInt(market.baseReserve);
  let quote = toBigInt(market.quoteReserve);
  const priceNow = () => ((quote * SCALE) / base).toString();
  const newestFirst: PricePoint[] = [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    newestFirst.push({ height: blocks[i].height, price: priceNow(), referencePrice: i === blocks.length - 1 ? referenceNow : null });
    for (const r of [...blocks[i].receipts].reverse()) {
      if (r.status !== "executed") continue;
      const amountIn = toBigInt(r.amountIn);
      const amountOut = toBigInt(r.amountOut);
      if (r.side === "sell") {
        base -= amountIn; // the pool had received the base...
        quote += amountOut; // ...and paid out the quote
      } else {
        base += amountOut;
        quote -= amountIn;
      }
    }
  }
  newestFirst.push({ height: blocks[0].height - 1, price: priceNow(), referencePrice: null });
  return newestFirst.reverse();
}

// ---- events --------------------------------------------------------------------------------------------

function applyEvent(state: ArenaState, event: Envelope): ArenaState {
  if (!state.synced) return state;
  if (state.seenEventIds.includes(event.eventId)) return state; // a redelivery
  const s: ArenaState = { ...state, seenEventIds: [...state.seenEventIds, event.eventId].slice(-MAX_SEEN_EVENTS) };
  switch (event.eventType) {
    case "TransactionAccepted":
      return onAccepted(s, event.payload);
    case "TransactionRejected":
      return onRejected(s, event.payload);
    case "TransactionDropped":
      return onDropped(s, event.payload);
    case "BlockProposed":
      return onProposed(s, event.payload);
    case "TransactionExecuted":
      return onExecuted(s, event.payload);
    case "SwapExecuted":
      return onSwap(s, event.payload);
    case "MarketPriceUpdated":
      return onPrice(s, event.payload);
    case "BlockCommitted":
      return onCommitted(s, event.payload);
    default:
      return state; // an event type this UI does not use
  }
}

function onAccepted(s: ArenaState, { transaction: tx }: TransactionAccepted): ArenaState {
  const known =
    s.mempool.some((t) => t.id === tx.id) ||
    s.building?.receipts.some((r) => r.transactionId === tx.id) ||
    s.blocks.some((b) => b.transactionIds.includes(tx.id));
  if (known) return s; // already in the snapshot
  // One transaction per (account, nonce): a higher-fee replacement pushes the old one out, as in the engine.
  const mempool = s.mempool.filter((t) => !(t.accountId === tx.accountId && t.nonce === tx.nonce));
  return { ...s, mempool: [...mempool, tx] };
}

function onRejected(s: ArenaState, p: TransactionRejected): ArenaState {
  const r = s.rejections;
  return {
    ...s,
    rejections: {
      total: r.total + 1,
      byReason: { ...r.byReason, [p.reason]: (r.byReason[p.reason] ?? 0) + 1 },
      recent: [p, ...r.recent].slice(0, MAX_RECENT_REJECTIONS),
    },
  };
}

function onDropped(s: ArenaState, p: TransactionDropped): ArenaState {
  return { ...s, mempool: s.mempool.filter((t) => t.id !== p.transactionId) };
}

function onProposed(s: ArenaState, p: BlockProposed): ArenaState {
  if (s.simulation && p.height <= s.simulation.height) return s;
  return { ...s, building: { height: p.height, policy: p.policy, receipts: [] } };
}

function onExecuted(s: ArenaState, p: TransactionExecuted): ArenaState {
  if (!s.building || s.building.height !== p.blockHeight) return s;
  const tx = s.mempool.find((t) => t.id === p.transactionId);
  const receipt: Receipt = {
    transactionId: p.transactionId,
    accountId: tx?.accountId ?? "unknown",
    position: p.position,
    status: p.status,
    side: tx?.side ?? "sell",
    amountIn: tx?.amountIn ?? "0",
    amountOut: "0", // filled in by SwapExecuted if it executed
    slippageBps: 0,
    errorCode: p.errorCode,
  };
  return {
    ...s,
    // Executed and failed transactions both leave the mempool.
    mempool: s.mempool.filter((t) => t.id !== p.transactionId),
    building: { ...s.building, receipts: [...s.building.receipts, receipt] },
  };
}

function onSwap(s: ArenaState, p: SwapExecuted): ArenaState {
  if (!s.building || !s.building.receipts.some((r) => r.transactionId === p.transactionId)) return s;
  const receipts = s.building.receipts.map((r) =>
    r.transactionId === p.transactionId
      ? { ...r, accountId: p.accountId, side: p.side, amountIn: p.amountIn, amountOut: p.amountOut, slippageBps: p.slippageBps }
      : r,
  );
  const accounts = { ...s.accounts };
  const account = accounts[p.accountId];
  if (account) {
    const amountIn = toBigInt(p.amountIn);
    const amountOut = toBigInt(p.amountOut);
    accounts[p.accountId] =
      p.side === "sell"
        ? { ...account, base: account.base - amountIn, quote: account.quote + amountOut }
        : { ...account, base: account.base + amountOut, quote: account.quote - amountIn };
  }
  return { ...s, accounts, building: { ...s.building, receipts } };
}

function onPrice(s: ArenaState, p: MarketPriceUpdated): ArenaState {
  if (!s.market || p.marketId !== s.market.marketId || p.version <= s.market.version) return s;
  return {
    ...s,
    market: {
      ...s.market,
      price: p.price,
      baseReserve: p.baseReserve,
      quoteReserve: p.quoteReserve,
      version: p.version,
      referencePrice: p.referencePrice ?? s.market.referencePrice ?? null,
    },
  };
}

function onCommitted(s: ArenaState, p: BlockCommitted): ArenaState {
  if (!s.simulation || p.height <= s.simulation.height) return s;
  const building = s.building?.height === p.height ? s.building : null;
  const block: BlockSummary = {
    height: p.height,
    policy: building?.policy ?? s.simulation.policy,
    transactionIds: p.transactionIds,
    executed: p.executed,
    failed: p.failed,
    stateRoot: p.stateRoot,
    receipts: [...(building?.receipts ?? [])].sort((a, b) => a.position - b.position),
  };
  const prices = s.market
    ? [...s.prices, { height: p.height, price: s.market.price, referencePrice: s.market.referencePrice ?? null }].slice(-(MAX_BLOCKS + 1))
    : s.prices;
  return {
    ...s,
    simulation: { ...s.simulation, height: p.height },
    building: null,
    blocks: [...s.blocks, block].slice(-MAX_BLOCKS),
    prices,
    // The engine sends TransactionDropped at the start of the next block; the mock does not. Applying the
    // rule (ADR-0010) here as well removes the same transactions one block earlier: at height + 1, anything
    // with expiresAt < height + 1 can never be included. Remove this once the mock sends TransactionDropped.
    mempool: s.mempool.filter((t) => t.expiresAt > p.height),
  };
}
