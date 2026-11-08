/**
 * The mock's three bots as plain decision functions: (what they can see, a seeded Rng) -> what they submit.
 * Stand-ins for the week-4 Python bots, tuned to make the policies visibly different, not to be optimal.
 */
import { BPS, SCALE, type AccountKind, type Side } from "../contract";
import { applySwap, isqrt, quoteOut, spotPrice, type Pool } from "./amm";
import type { Balance } from "./execution";
import type { Rng } from "./rng";

export interface AccountSetup {
  accountId: string;
  kind: AccountKind;
  startBase: bigint;
  startQuote: bigint;
}

export const NOISE_TRADERS = 20;
export const ARB_ID = "arb-1";
export const SANDWICH_ID = "sandwich-1";

const units = (whole: number) => BigInt(whole) * SCALE;

export function initialAccounts(): AccountSetup[] {
  const accounts: AccountSetup[] = [];
  for (let n = 1; n <= NOISE_TRADERS; n++) {
    accounts.push({ accountId: `noise-${n}`, kind: "noise", startBase: units(100), startQuote: units(100_000) });
  }
  accounts.push({ accountId: ARB_ID, kind: "arb", startBase: units(500), startQuote: units(500_000) });
  accounts.push({ accountId: SANDWICH_ID, kind: "sandwich", startBase: units(300), startQuote: units(300_000) });
  return accounts;
}

/** What a bot wants to submit. The simulation adds nonce, ids and expiry. */
export interface Intent {
  accountId: string;
  side: Side;
  amountIn: bigint;
  minAmountOut: bigint;
  priorityFee: bigint;
  /** How many blocks after submission it may still be included in. */
  ttlBlocks: number;
}

const opposite = (side: Side): Side => (side === "buy" ? "sell" : "buy");
const applyTolerance = (amount: bigint, toleranceBps: bigint) => (amount * (BPS - toleranceBps)) / BPS;

// ---- noise traders -------------------------------------------------------------------------------------

/** One interval's random draws for one noise trader. All fields are always drawn, in the same order. */
export interface NoiseDraw {
  wants: boolean;
  side: Side;
  /** Trade size in thousandths of a base token. */
  baseMilli: number;
  /** Slippage tolerance the trader accepts, 0.5 % to 2 %. */
  toleranceBps: number;
  priorityFee: number;
  /** Re-send the pending transaction with the same idempotency key (a client retry). */
  retry: boolean;
}

export function drawNoise(rng: Rng): NoiseDraw {
  const wants = rng.chance(0.45);
  const side: Side = rng.chance(0.5) ? "buy" : "sell";
  const bucket = rng.next();
  const baseMilli = bucket < 0.7 ? rng.int(50, 1_500) : bucket < 0.94 ? rng.int(1_500, 5_000) : rng.int(5_000, 15_000);
  const toleranceBps = rng.int(50, 200);
  const priorityFee = rng.int(0, 20);
  const retry = rng.chance(0.03);
  return { wants, side, baseMilli, toleranceBps, priorityFee, retry };
}

export function noiseIntent(accountId: string, draw: NoiseDraw, pool: Pool): Intent {
  const baseAmount = (BigInt(draw.baseMilli) * SCALE) / 1000n;
  const amountIn = draw.side === "sell" ? baseAmount : (baseAmount * spotPrice(pool)) / SCALE;
  // Like a wallet: quote the swap at the current pool, then accept up to `toleranceBps` less.
  const minAmountOut = applyTolerance(quoteOut(pool, draw.side, amountIn), BigInt(draw.toleranceBps));
  return { accountId, side: draw.side, amountIn, minAmountOut, priorityFee: BigInt(draw.priorityFee), ttlBlocks: 3 };
}

// ---- arbitrage bot -------------------------------------------------------------------------------------

/** The arb bot ignores gaps smaller than this (the pool fee is 30 bps). */
export const ARB_THRESHOLD_BPS = 50n;

/**
 * Trade the pool toward `reference` (an external price, SCALE fixed point). Sized so that, fees aside, the
 * pool price lands on the reference: for x * y = k, the quote reserve at price P is sqrt(k * P).
 */
export function arbIntent(pool: Pool, reference: bigint, balance: Balance): Intent | null {
  const price = spotPrice(pool);
  const gapBps = ((reference - price) * BPS) / price;
  if (gapBps <= ARB_THRESHOLD_BPS && gapBps >= -ARB_THRESHOLD_BPS) return null;

  const k = pool.baseReserve * pool.quoteReserve;
  const feeFactor = BPS - BigInt(pool.feeBps);
  let side: Side;
  let amountIn: bigint;
  if (gapBps > 0n) {
    // The pool is cheaper than the reference: buy base with quote until the quote reserve reaches sqrt(k * P).
    side = "buy";
    amountIn = ((isqrt((k * reference) / SCALE) - pool.quoteReserve) * BPS) / feeFactor;
    amountIn = min(amountIn, (balance.quote * 8n) / 10n);
  } else {
    side = "sell";
    amountIn = ((isqrt((k * SCALE) / reference) - pool.baseReserve) * BPS) / feeFactor;
    amountIn = min(amountIn, (balance.base * 8n) / 10n);
  }
  if (amountIn <= 0n) return null;
  const minAmountOut = applyTolerance(quoteOut(pool, side, amountIn), 50n);
  return { accountId: ARB_ID, side, amountIn, minAmountOut, priorityFee: 8n, ttlBlocks: 1 };
}

/** Move the reference price one step: a seeded random walk of -40..+40 bps per block. Integers only. */
export function nextReferencePrice(reference: bigint, rng: Rng): bigint {
  const stepBps = BigInt(rng.int(-40, 40));
  return (reference * (BPS + stepBps)) / BPS;
}

// ---- sandwich bot --------------------------------------------------------------------------------------

/** Swaps worth less than this (in quote) are not worth sandwiching. */
export const SANDWICH_MIN_VICTIM_QUOTE = 3_000n * SCALE;
/** Skip a sandwich expected to earn less than this (in quote). */
export const SANDWICH_MIN_PROFIT_QUOTE = 1n * SCALE;

export interface VictimView {
  side: Side;
  amountIn: bigint;
  minAmountOut: bigint;
  priorityFee: bigint;
}

export interface SandwichPlan {
  /** Same side as the victim, one fee unit above it: goes first under PRIORITY_FEE. */
  front: Intent;
  /** Opposite side, sells/buys back what the front got, one fee unit below the victim. */
  back: Intent;
  expectedProfitQuote: bigint;
}

/**
 * Plan a sandwich around a pending swap, assuming nothing else executes in between.
 * The front is the largest that still lets the victim clear its own minAmountOut (less a 10 % margin):
 * front-run harder and the victim reverts, and the bot just pays fees twice.
 */
export function sandwichPlan(pool: Pool, victim: VictimView, balance: Balance): SandwichPlan | null {
  const victimValue = victim.side === "sell" ? (victim.amountIn * spotPrice(pool)) / SCALE : victim.amountIn;
  if (victimValue < SANDWICH_MIN_VICTIM_QUOTE) return null;

  const minOut = victim.minAmountOut > 1n ? victim.minAmountOut : 1n;
  const victimClears = (front: bigint) => {
    const afterFront = front > 0n ? applySwap(pool, victim.side, front).pool : pool;
    return quoteOut(afterFront, victim.side, victim.amountIn) >= minOut;
  };
  if (!victimClears(0n)) return null;

  // The front pays the same asset as the victim.
  const inventory = victim.side === "sell" ? balance.base : balance.quote;
  let lo = 0n; // victimClears(lo) is always true
  let hi = (inventory * 8n) / 10n;
  if (hi <= 0n) return null;
  if (!victimClears(hi)) {
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      if (victimClears(mid)) lo = mid;
      else hi = mid;
    }
    hi = lo;
  }
  const frontIn = (hi * 9n) / 10n;
  if (frontIn <= 0n) return null;

  const s1 = applySwap(pool, victim.side, frontIn);
  const s2 = applySwap(s1.pool, victim.side, victim.amountIn);
  const s3 = applySwap(s2.pool, opposite(victim.side), s1.amountOut);
  const profit =
    victim.side === "sell"
      ? ((s3.amountOut - frontIn) * spotPrice(s3.pool)) / SCALE // got back more base than it sold
      : s3.amountOut - frontIn; // got back more quote than it paid
  if (profit < SANDWICH_MIN_PROFIT_QUOTE) return null;

  const backFee = victim.priorityFee > 0n ? victim.priorityFee - 1n : 0n;
  return {
    front: { accountId: SANDWICH_ID, side: victim.side, amountIn: frontIn, minAmountOut: 0n, priorityFee: victim.priorityFee + 1n, ttlBlocks: 1 },
    back: { accountId: SANDWICH_ID, side: opposite(victim.side), amountIn: s1.amountOut, minAmountOut: 0n, priorityFee: backFee, ttlBlocks: 1 },
    expectedProfitQuote: profit,
  };
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
