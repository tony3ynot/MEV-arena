/**
 * MEV Arena wire contract (DRAFT, week 4).
 *
 * Every shape the UI receives from, or sends to, the gateway (apps/api) is declared in this one file.
 * When the FastAPI gateway exists, replace the TYPES section with types generated from its OpenAPI
 * schema (ADR-0003, contract-first) and keep the HELPERS section. If the generated names match these,
 * nothing else in the UI changes.
 *
 * Conventions
 * - JSON keys are camelCase.
 * - Token amounts, priority fees and fixed-point prices are `DecimalString`s: base-10 integers in minimal
 *   units (1 token = 1e18 units, ADR-0004 / ADR-0007). They exceed 2^53, so parse them with `toBigInt`,
 *   never `Number()`. Convert to a float only at the very edge, for display (lib/format.ts).
 * - A price is quote per base, fixed point with SCALE decimals: `price = quoteReserve * SCALE / baseReserve`.
 * - Small counters (height, nonce, position, bps, version, seed, capacity) are plain JSON numbers.
 * - Timestamps are RFC 3339 strings.
 * - MOCK-ONLY marks a field the in-browser mock sends and the real gateway may leave out; the UI copes.
 * - UI-DRAFT ADDITION marks a field the original draft did not have; the README says why the UI needs it.
 */

// =====================================================================================================
// TYPES
// =====================================================================================================

/** Base-10 integer string, e.g. "1000000000000000000" (= 1 token). Matches /^-?\d+$/. */
export type DecimalString = string;
/** RFC 3339 timestamp, e.g. "2026-11-05T10:00:00.000Z". */
export type Rfc3339 = string;

export type Side = "buy" | "sell"; // buy: pay quote, receive base. sell: pay base, receive quote.
export type Policy = "fifo" | "priority_fee" | "random" | "adversarial";
export type SimulationStatus = "running" | "paused";
export type AccountKind = "noise" | "arb" | "sandwich" | "user";
export type TxStatus = "executed" | "failed";
export type ErrorCode = "slippage" | "insufficient_balance" | "bad_nonce" | "unknown_market";
/**
 * Why the mempool turned a submission away: the engine's `Admission` verdict values, sent as they are.
 * ("stale_nonce" is an admission verdict; "bad_nonce" in ErrorCode is an execution failure.)
 */
export type RejectReason = "pool_full" | "stale_nonce" | "expired" | "duplicate" | "conflict" | "underpriced";
/**
 * Why a pending transaction left the mempool without being included in a block.
 * expired: past its expiresAt (ADR-0010). replaced: same (account, nonce) with a higher fee came in.
 * evicted: the pool was full and a higher-fee transaction pushed out the cheapest (ADR-0009).
 */
export type DropReason = "expired" | "replaced" | "evicted";

export const POLICIES: readonly Policy[] = ["fifo", "priority_fee", "random", "adversarial"];
export const ACCOUNT_KINDS: readonly AccountKind[] = ["noise", "arb", "sandwich", "user"];

export interface SimulationState {
  status: SimulationStatus;
  /** Height of the last committed block (0 before the first block). */
  height: number;
  policy: Policy;
  /** Must stay below 2^53 while it travels as a JSON number. */
  seed: number;
  /** Maximum transactions per block. */
  capacity: number;
  blockIntervalMs: number;
  /** When the next block is due; null while paused. Server clock, so the countdown can be off by any clock skew. */
  nextBlockAt: Rfc3339 | null;
}

/** A pending transaction (spec §9 Transaction without `status`: everything in the mempool is pending). */
export interface Tx {
  id: string;
  idempotencyKey: string;
  accountId: string;
  nonce: number;
  marketId: string;
  side: Side;
  /** Paid in: base for a sell, quote for a buy. */
  amountIn: DecimalString;
  /** Received out at least this much, or the swap fails with "slippage". */
  minAmountOut: DecimalString;
  /** Virtual bid for ordering; the engine never charges it. A string because it is an unbounded int. */
  priorityFee: DecimalString;
  /** Block height when it was submitted (the last committed height at that moment). */
  submittedAt: number;
  /** Last block height this transaction may be included in (ADR-0010: expired when expiresAt < height). */
  expiresAt: number;
}

export interface Market {
  marketId: string;
  baseAsset: string;
  quoteAsset: string;
  baseReserve: DecimalString;
  quoteReserve: DecimalString;
  feeBps: number;
  /** quoteReserve * SCALE / baseReserve, floored. */
  price: DecimalString;
  version: number;
  /** MOCK-ONLY: the arbitrage bot's external reference price, same fixed-point scale as `price`. */
  referencePrice?: DecimalString | null;
}

/** One transaction's result inside a block, as the UI needs it. */
export interface Receipt {
  transactionId: string;
  accountId: string;
  position: number;
  status: TxStatus;
  side: Side;
  amountIn: DecimalString;
  /** "0" when the transaction failed. */
  amountOut: DecimalString;
  /** 0 when the transaction failed. Floored by the engine (ADR-0007). */
  slippageBps: number;
  errorCode: ErrorCode | null;
}

export interface BlockSummary {
  height: number;
  policy: Policy;
  /** In execution order. */
  transactionIds: string[];
  executed: number;
  failed: number;
  stateRoot: string;
  /** In execution order (by position). */
  receipts: Receipt[];
}

export interface AccountInfo {
  /** `${kind}-${n}`, e.g. "noise-3", "sandwich-1". */
  accountId: string;
  kind: AccountKind;
  startBase: DecimalString;
  startQuote: DecimalString;
  /**
   * UI-DRAFT ADDITION: balances as of the snapshot's height. Without them the UI can only rebuild balances
   * from the blocks it has seen, so P&L would be wrong after any reconnect once height > recentBlocks.length.
   */
  baseBalance: DecimalString;
  quoteBalance: DecimalString;
}

// ---- event payloads (spec §11) ----------------------------------------------------------------------

export interface TransactionAccepted {
  transaction: Tx;
}

export interface TransactionRejected {
  idempotencyKey: string;
  accountId: string;
  reason: RejectReason;
}

export interface TransactionDropped {
  transactionId: string;
  reason: DropReason;
}

export interface BlockProposed {
  height: number;
  policy: Policy;
  /** In execution order. */
  transactionIds: string[];
}

export interface TransactionExecuted {
  transactionId: string;
  blockHeight: number;
  position: number;
  status: TxStatus;
  errorCode: ErrorCode | null;
}

export interface SwapExecuted {
  transactionId: string;
  marketId: string;
  accountId: string;
  side: Side;
  amountIn: DecimalString;
  amountOut: DecimalString;
  /** Quote per base actually paid or received, SCALE fixed point. */
  effectivePrice: DecimalString;
  slippageBps: number;
  /** Part of amountIn kept by the pool (in the input asset). */
  feePaid: DecimalString;
}

export interface MarketPriceUpdated {
  marketId: string;
  price: DecimalString;
  baseReserve: DecimalString;
  quoteReserve: DecimalString;
  version: number;
  /** MOCK-ONLY, see Market.referencePrice. */
  referencePrice?: DecimalString | null;
}

export interface BlockCommitted {
  height: number;
  stateRoot: string;
  transactionIds: string[];
  executed: number;
  failed: number;
}

/** Spec §11 common envelope fields. */
interface EnvelopeBase {
  eventId: string;
  eventVersion: number;
  /** Partition key; the market id for every event here (spec §12). */
  aggregateId: string;
  occurredAt: Rfc3339;
  correlationId: string;
  causationId: string;
}

/**
 * An event, discriminated by `eventType`. Delivery is at-least-once, so the reducer drops repeated eventIds.
 *
 * Emission order per block: TransactionDropped for each expired transaction; then each submission in
 * arrival order as TransactionAccepted or TransactionRejected, an Accepted one followed by TransactionDropped
 * if it replaced or evicted another; then BlockProposed; then per transaction TransactionExecuted
 * (+ SwapExecuted if it executed); then MarketPriceUpdated (only if at least one swap executed, as in the
 * engine); then BlockCommitted. Executed and failed transactions leave the mempool; transactions not
 * selected stay.
 *
 * Event types the UI does not know (TransactionSubmitted, SnapshotCreated, ...) pass `parseFrame` and are
 * ignored by the reducer.
 */
export type Envelope =
  | (EnvelopeBase & { eventType: "TransactionAccepted"; payload: TransactionAccepted })
  | (EnvelopeBase & { eventType: "TransactionRejected"; payload: TransactionRejected })
  | (EnvelopeBase & { eventType: "TransactionDropped"; payload: TransactionDropped })
  | (EnvelopeBase & { eventType: "BlockProposed"; payload: BlockProposed })
  | (EnvelopeBase & { eventType: "TransactionExecuted"; payload: TransactionExecuted })
  | (EnvelopeBase & { eventType: "SwapExecuted"; payload: SwapExecuted })
  | (EnvelopeBase & { eventType: "MarketPriceUpdated"; payload: MarketPriceUpdated })
  | (EnvelopeBase & { eventType: "BlockCommitted"; payload: BlockCommitted });

export type EventType = Envelope["eventType"];

// ---- WebSocket frames: GET /v1/stream ----------------------------------------------------------------

/**
 * Sent first on every connect, and again whenever the server's state is reset (replay).
 *
 * Why the stream starts with a snapshot instead of "GET the state over REST, then subscribe": anything that
 * happens between the GET returning and the subscription starting would be lost. The server subscribes the
 * client first, then takes the snapshot and sends it, then the live events, so there is no gap. The price is
 * a possible overlap (an event already reflected in the snapshot); the reducer drops block events at or
 * below the snapshot height and transactions it already knows.
 *
 * The snapshot is taken between blocks, never in the middle of one.
 */
export interface SnapshotFrame {
  kind: "snapshot";
  simulation: SimulationState;
  /** The v0.1 arena has exactly one market. */
  market: Market;
  /** In arrival order. */
  mempool: Tx[];
  /** Ascending by height, the most recent N blocks (the mock sends 100). */
  recentBlocks: BlockSummary[];
  accounts: AccountInfo[];
}

export interface EventFrame {
  kind: "event";
  event: Envelope;
}

/** Sent whenever SimulationState changes: pause, resume, step, replay, and after every block (height and nextBlockAt move). */
export interface SimulationFrame {
  kind: "simulation";
  state: SimulationState;
}

export type Frame = SnapshotFrame | EventFrame | SimulationFrame;

// ---- REST ---------------------------------------------------------------------------------------------
// POST /v1/simulation/pause   -> SimulationState
// POST /v1/simulation/resume  -> SimulationState
// POST /v1/simulation/step    -> SimulationState   (builds one block now; only while paused)
// POST /v1/simulation/replay  body ReplayRequest -> SimulationState
//   Re-runs the same bot inputs from height 0 under `policy`. The run keeps its running/paused status.
//   Every open stream then receives a fresh `snapshot` frame, because all previous state is gone.

export interface ReplayRequest {
  policy: Policy;
  seed: number;
}

// =====================================================================================================
// HELPERS (keep these when the types above become generated)
// =====================================================================================================

/** Minimal units per whole token. */
export const SCALE = 10n ** 18n;
/** Basis points in 100 %. */
export const BPS = 10_000n;

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

const DECIMAL = /^-?\d+$/;

/** Parse a DecimalString. Throws instead of guessing. */
export function toBigInt(value: DecimalString): bigint {
  if (typeof value !== "string" || !DECIMAL.test(value)) {
    throw new ContractError(`not a decimal string: ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

/**
 * Parse one WebSocket message into a Frame, with light runtime checks: the frame kind, required fields,
 * and that every amount is a decimal string. It is not a full schema validator; a validator generated
 * from the OpenAPI schema can replace it later.
 */
export function parseFrame(text: string): Frame {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw)) throw new ContractError("frame is not an object");
  switch (raw.kind) {
    case "snapshot":
      check(raw.simulation, "SimulationState", "snapshot.simulation");
      check(raw.market, "Market", "snapshot.market");
      eachOf(raw.mempool, "Tx", "snapshot.mempool");
      eachOf(raw.recentBlocks, "BlockSummary", "snapshot.recentBlocks");
      if (Array.isArray(raw.recentBlocks)) {
        raw.recentBlocks.forEach((b, i) => eachOf(isRecord(b) ? b.receipts : undefined, "Receipt", `snapshot.recentBlocks[${i}].receipts`));
      }
      eachOf(raw.accounts, "AccountInfo", "snapshot.accounts");
      break;
    case "event": {
      check(raw.event, "Envelope", "event");
      const event = raw.event as Record<string, unknown>;
      const shape = PAYLOAD_SHAPE[event.eventType as string];
      if (shape) check(event.payload, shape, `event.payload(${String(event.eventType)})`);
      if (event.eventType === "TransactionAccepted" && isRecord(event.payload)) {
        check(event.payload.transaction, "Tx", "event.payload.transaction");
      }
      break;
    }
    case "simulation":
      check(raw.state, "SimulationState", "simulation.state");
      break;
    default:
      throw new ContractError(`unknown frame kind: ${JSON.stringify(raw.kind)}`);
  }
  return raw as unknown as Frame;
}

/** Validate a REST response body (SimulationState). */
export function parseSimulationState(value: unknown): SimulationState {
  check(value, "SimulationState", "response");
  return value as SimulationState;
}

// ---- runtime shape table ------------------------------------------------------------------------------

interface Shape {
  decimals?: string[];
  optionalDecimals?: string[];
  numbers?: string[];
  strings?: string[];
  arrays?: string[];
}

const SHAPES: Record<string, Shape> = {
  SimulationState: { strings: ["status", "policy"], numbers: ["height", "seed", "capacity", "blockIntervalMs"] },
  Tx: {
    strings: ["id", "idempotencyKey", "accountId", "marketId", "side"],
    numbers: ["nonce", "submittedAt", "expiresAt"],
    decimals: ["amountIn", "minAmountOut", "priorityFee"],
  },
  Market: {
    strings: ["marketId", "baseAsset", "quoteAsset"],
    numbers: ["feeBps", "version"],
    decimals: ["baseReserve", "quoteReserve", "price"],
    optionalDecimals: ["referencePrice"],
  },
  Receipt: {
    strings: ["transactionId", "accountId", "status", "side"],
    numbers: ["position", "slippageBps"],
    decimals: ["amountIn", "amountOut"],
  },
  BlockSummary: { strings: ["policy", "stateRoot"], numbers: ["height", "executed", "failed"], arrays: ["transactionIds", "receipts"] },
  AccountInfo: { strings: ["accountId", "kind"], decimals: ["startBase", "startQuote", "baseBalance", "quoteBalance"] },
  Envelope: { strings: ["eventId", "eventType", "aggregateId", "occurredAt", "correlationId", "causationId"], numbers: ["eventVersion"] },
  TransactionAccepted: {},
  TransactionRejected: { strings: ["idempotencyKey", "accountId", "reason"] },
  TransactionDropped: { strings: ["transactionId", "reason"] },
  BlockProposed: { strings: ["policy"], numbers: ["height"], arrays: ["transactionIds"] },
  TransactionExecuted: { strings: ["transactionId", "status"], numbers: ["blockHeight", "position"] },
  SwapExecuted: {
    strings: ["transactionId", "marketId", "accountId", "side"],
    numbers: ["slippageBps"],
    decimals: ["amountIn", "amountOut", "effectivePrice", "feePaid"],
  },
  MarketPriceUpdated: {
    strings: ["marketId"],
    numbers: ["version"],
    decimals: ["price", "baseReserve", "quoteReserve"],
    optionalDecimals: ["referencePrice"],
  },
  BlockCommitted: { strings: ["stateRoot"], numbers: ["height", "executed", "failed"], arrays: ["transactionIds"] },
};

const PAYLOAD_SHAPE: Record<string, string> = {
  TransactionAccepted: "TransactionAccepted",
  TransactionRejected: "TransactionRejected",
  TransactionDropped: "TransactionDropped",
  BlockProposed: "BlockProposed",
  TransactionExecuted: "TransactionExecuted",
  SwapExecuted: "SwapExecuted",
  MarketPriceUpdated: "MarketPriceUpdated",
  BlockCommitted: "BlockCommitted",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function check(value: unknown, shapeName: string, path: string): void {
  if (!isRecord(value)) throw new ContractError(`${path}: expected an object`);
  const shape = SHAPES[shapeName];
  for (const f of shape.strings ?? []) {
    if (typeof value[f] !== "string") throw new ContractError(`${path}.${f}: expected a string`);
  }
  for (const f of shape.numbers ?? []) {
    if (typeof value[f] !== "number") throw new ContractError(`${path}.${f}: expected a number`);
  }
  for (const f of shape.arrays ?? []) {
    if (!Array.isArray(value[f])) throw new ContractError(`${path}.${f}: expected an array`);
  }
  for (const f of shape.decimals ?? []) {
    if (typeof value[f] !== "string" || !DECIMAL.test(value[f] as string)) {
      throw new ContractError(`${path}.${f}: expected a decimal string, got ${JSON.stringify(value[f])}`);
    }
  }
  for (const f of shape.optionalDecimals ?? []) {
    const v = value[f];
    if (v !== undefined && v !== null && (typeof v !== "string" || !DECIMAL.test(v))) {
      throw new ContractError(`${path}.${f}: expected a decimal string or null, got ${JSON.stringify(v)}`);
    }
  }
}

function eachOf(value: unknown, shapeName: string, path: string): void {
  if (!Array.isArray(value)) throw new ContractError(`${path}: expected an array`);
  value.forEach((item, i) => check(item, shapeName, `${path}[${i}]`));
}
