import { describe, expect, it } from "vitest";
import { SCALE } from "../lib/contract";
import { applySwap, getAmountOut, isqrt, slippageBps, spotPrice, type Pool } from "../lib/mock/amm";
import { Rng } from "../lib/mock/rng";

const ETH_USDC: Pool = {
  marketId: "eth-usdc",
  baseAsset: "ETH",
  quoteAsset: "USDC",
  baseReserve: 1_000n * SCALE,
  quoteReserve: 1_000_000n * SCALE,
  feeBps: 30,
  version: 0,
};

describe("mock AMM math matches the Python engine", () => {
  it("sells 1 / 10 / 100 ETH into 1000 x 1,000,000 at 30 bps like test_amm.py's prediction table", () => {
    const rows: [bigint, bigint, number][] = [
      [1n, 996n, 39],
      [10n, 9_871n, 128],
      [100n, 90_661n, 933],
    ];
    for (const [whole, expectedOut, expectedSlip] of rows) {
      const { pool, amountOut } = applySwap(ETH_USDC, "sell", whole * SCALE);
      expect(amountOut / SCALE).toBe(expectedOut);
      expect(slippageBps(whole * SCALE, amountOut, spotPrice(ETH_USDC), "sell")).toBe(expectedSlip);
      expect(pool.version).toBe(1);
    }
  });

  it("follows out = rOut * inAfterFee / (rIn * 10000 + inAfterFee) exactly", () => {
    const amountIn = 10n * SCALE;
    const inAfterFee = amountIn * 9_970n;
    const expected = (1_000_000n * SCALE * inAfterFee) / (1_000n * SCALE * 10_000n + inAfterFee);
    expect(getAmountOut(amountIn, 1_000n * SCALE, 1_000_000n * SCALE, 30)).toBe(expected);
  });

  it("starts at a price of 1000 USDC, fixed point", () => {
    expect(spotPrice(ETH_USDC)).toBe(1_000n * SCALE);
  });

  it("never lets k decrease (seeded random swaps)", () => {
    const rng = new Rng(7);
    let pool = ETH_USDC;
    for (let i = 0; i < 500; i++) {
      const side = rng.chance(0.5) ? "sell" : "buy";
      const amountIn = BigInt(rng.int(1, 1_000_000)) * 10n ** BigInt(rng.int(0, 21));
      const kBefore = pool.baseReserve * pool.quoteReserve;
      pool = applySwap(pool, side, amountIn).pool;
      expect(pool.baseReserve * pool.quoteReserve >= kBefore).toBe(true);
      expect(pool.baseReserve > 0n && pool.quoteReserve > 0n).toBe(true);
    }
  });

  it("isqrt floors", () => {
    expect(isqrt(0n)).toBe(0n);
    expect(isqrt(15n)).toBe(3n);
    expect(isqrt(16n)).toBe(4n);
    const big = 123_456_789_012_345_678_901_234_567_890n;
    const r = isqrt(big);
    expect(r * r <= big && (r + 1n) * (r + 1n) > big).toBe(true);
  });
});
