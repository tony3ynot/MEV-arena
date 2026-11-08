/**
 * Constant-product AMM math, a TypeScript copy of packages/simulation-engine/.../amm (ADR-0007).
 *
 * BigInt only. BigInt division truncates toward zero, which for these positive values is the same floor
 * the Python engine uses, so the numbers agree to the unit.
 */
import { BPS, SCALE, type Side } from "../contract";

export interface Pool {
  marketId: string;
  baseAsset: string;
  quoteAsset: string;
  baseReserve: bigint;
  quoteReserve: bigint;
  feeBps: number;
  version: number;
}

/**
 * Amount received for `amountIn` paid into the pool, Uniswap-v2 style (fee taken on input):
 *   inAfterFee = amountIn * (10000 - feeBps)
 *   out = reserveOut * inAfterFee / (reserveIn * 10000 + inAfterFee)      (floored)
 */
export function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: number): bigint {
  if (amountIn <= 0n) throw new Error("amountIn must be positive");
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error("reserves must be positive");
  if (feeBps < 0 || feeBps >= 10_000) throw new Error("feeBps must be in [0, 10000)");
  const inAfterFee = amountIn * (BPS - BigInt(feeBps));
  return (reserveOut * inAfterFee) / (reserveIn * BPS + inAfterFee);
}

/** Part of amountIn kept by the pool as fee (floored). */
export function feeOf(amountIn: bigint, feeBps: number): bigint {
  return (amountIn * BigInt(feeBps)) / BPS;
}

/** Spot price: quote per base, SCALE fixed point. */
export function spotPrice(pool: Pool): bigint {
  return (pool.quoteReserve * SCALE) / pool.baseReserve;
}

/** What a swap would return right now, without changing anything. */
export function quoteOut(pool: Pool, side: Side, amountIn: bigint): bigint {
  return side === "sell"
    ? getAmountOut(amountIn, pool.baseReserve, pool.quoteReserve, pool.feeBps)
    : getAmountOut(amountIn, pool.quoteReserve, pool.baseReserve, pool.feeBps);
}

/** Execute a swap and return the new pool (the old one is not changed) and the amount out. */
export function applySwap(pool: Pool, side: Side, amountIn: bigint): { pool: Pool; amountOut: bigint } {
  const amountOut = quoteOut(pool, side, amountIn);
  const next: Pool =
    side === "sell"
      ? { ...pool, baseReserve: pool.baseReserve + amountIn, quoteReserve: pool.quoteReserve - amountOut }
      : { ...pool, baseReserve: pool.baseReserve - amountOut, quoteReserve: pool.quoteReserve + amountIn };
  next.version = pool.version + 1;
  return { pool: next, amountOut };
}

/** How much worse than the pre-trade spot price the fill was, in bps (floored, never negative). */
export function slippageBps(amountIn: bigint, amountOut: bigint, spot: bigint, side: Side): number {
  const expectedOut = side === "sell" ? (amountIn * spot) / SCALE : (amountIn * SCALE) / spot;
  if (expectedOut <= 0n) return 0;
  const bps = ((expectedOut - amountOut) * BPS) / expectedOut;
  return bps > 0n ? Number(bps) : 0;
}

/** Integer square root (floor), Newton's method. Used by the arbitrage bot to size its trade. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of a negative number");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}
