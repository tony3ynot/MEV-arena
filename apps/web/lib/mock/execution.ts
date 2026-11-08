/**
 * Execute transactions against the mock world, following the engine's execution module (ADR-0007):
 * checks run nonce -> market -> balance -> swap -> minAmountOut and stop at the first failure.
 * A failed transaction consumes its nonce and changes nothing else, except BAD_NONCE, which consumes nothing.
 *
 * Unlike the Python engine (pure functions), this stand-in mutates the world in place; it is simpler to read
 * and nothing outside MockSimulation can see the world.
 */
import { SCALE, type ErrorCode, type Side, type TxStatus } from "../contract";
import { applySwap, feeOf, slippageBps, spotPrice, type Pool } from "./amm";

/** A pending transaction inside the mock, with real bigints. lib/mock/sim.ts turns it into a wire `Tx`. */
export interface MockTx {
  id: string;
  idempotencyKey: string;
  accountId: string;
  nonce: number;
  marketId: string;
  side: Side;
  amountIn: bigint;
  minAmountOut: bigint;
  priorityFee: bigint;
  submittedAt: number;
  expiresAt: number;
}

export interface Balance {
  base: bigint;
  quote: bigint;
}

export interface World {
  pool: Pool;
  balances: Map<string, Balance>;
  /** accountId -> next expected nonce (0 if the account never transacted). */
  nonces: Map<string, number>;
}

export interface MockReceipt {
  tx: MockTx;
  position: number;
  status: TxStatus;
  errorCode: ErrorCode | null;
  amountOut: bigint;
  effectivePrice: bigint;
  slippageBps: number;
  feePaid: bigint;
}

export function nextNonce(world: World, accountId: string): number {
  return world.nonces.get(accountId) ?? 0;
}

export function balanceOf(world: World, accountId: string): Balance {
  return world.balances.get(accountId) ?? { base: 0n, quote: 0n };
}

function failed(tx: MockTx, position: number, errorCode: ErrorCode): MockReceipt {
  return { tx, position, status: "failed", errorCode, amountOut: 0n, effectivePrice: 0n, slippageBps: 0, feePaid: 0n };
}

/** Apply one transaction to `world` (mutated) and return its receipt. */
export function executeTx(world: World, tx: MockTx, position: number): MockReceipt {
  if (tx.nonce !== nextNonce(world, tx.accountId)) {
    // The one failure that does not consume a nonce, so the correctly numbered transaction can still land.
    return failed(tx, position, "bad_nonce");
  }
  world.nonces.set(tx.accountId, tx.nonce + 1);

  const pool = world.pool;
  if (tx.marketId !== pool.marketId) return failed(tx, position, "unknown_market");

  const balance = balanceOf(world, tx.accountId);
  const available = tx.side === "sell" ? balance.base : balance.quote;
  if (available < tx.amountIn) return failed(tx, position, "insufficient_balance");

  const spot = spotPrice(pool);
  const { pool: nextPool, amountOut } = applySwap(pool, tx.side, tx.amountIn);
  const minOut = tx.minAmountOut > 1n ? tx.minAmountOut : 1n; // a zero fill is a failure, as in Uniswap v2
  if (amountOut < minOut) return failed(tx, position, "slippage");

  world.pool = nextPool;
  world.balances.set(
    tx.accountId,
    tx.side === "sell"
      ? { base: balance.base - tx.amountIn, quote: balance.quote + amountOut }
      : { base: balance.base + amountOut, quote: balance.quote - tx.amountIn },
  );
  return {
    tx,
    position,
    status: "executed",
    errorCode: null,
    amountOut,
    effectivePrice: tx.side === "sell" ? (amountOut * SCALE) / tx.amountIn : (tx.amountIn * SCALE) / amountOut,
    slippageBps: slippageBps(tx.amountIn, amountOut, spot, tx.side),
    feePaid: feeOf(tx.amountIn, pool.feeBps),
  };
}

/** Deterministic text of the whole world, the input to the mock state root. Sorted keys, amounts as strings. */
export function canonicalJson(world: World): string {
  const accounts = [...world.balances.keys()].sort();
  const balances: Record<string, { base: string; quote: string }> = {};
  for (const id of accounts) {
    const b = world.balances.get(id)!;
    balances[id] = { base: b.base.toString(), quote: b.quote.toString() };
  }
  const nonces: Record<string, number> = {};
  for (const id of [...world.nonces.keys()].sort()) nonces[id] = world.nonces.get(id)!;
  const p = world.pool;
  return JSON.stringify({
    balances,
    markets: {
      [p.marketId]: {
        baseAsset: p.baseAsset,
        baseReserve: p.baseReserve.toString(),
        feeBps: p.feeBps,
        quoteAsset: p.quoteAsset,
        quoteReserve: p.quoteReserve.toString(),
        version: p.version,
      },
    },
    nonces,
  });
}
