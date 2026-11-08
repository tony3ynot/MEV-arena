import { describe, expect, it } from "vitest";
import { SCALE } from "../lib/contract";
import { buildBlock, type BuildOptions } from "../lib/mock/builder";
import type { MockTx } from "../lib/mock/execution";

// The same fixtures as packages/simulation-engine/tests/test_block_builder.py.
function tx(id: string, account: string, nonce: number, fee = 0): MockTx {
  return {
    id,
    idempotencyKey: `key-${id}`,
    accountId: account,
    nonce,
    marketId: "eth-usdc",
    side: "sell",
    amountIn: SCALE,
    minAmountOut: 0n,
    priorityFee: BigInt(fee),
    submittedAt: 0,
    expiresAt: 10,
  };
}

const fresh = () => 0;
const ids = (block: MockTx[]) => block.map((t) => t.id);
const build = (candidates: MockTx[], options: Partial<BuildOptions> = {}, nextNonce: (a: string) => number = fresh) =>
  buildBlock(candidates, nextNonce, { policy: "priority_fee", capacity: 10, seed: 0, ...options });

// x, y, z: a higher fee on alice's second transaction must not let it jump her first.
const XYZ = [tx("x", "alice", 0, 1), tx("y", "alice", 1, 5), tx("z", "bob", 0, 3)];

describe("mock builder mirrors block_builder (ADR-0011)", () => {
  it("keeps each account's nonce order under PRIORITY_FEE", () => {
    expect(ids(build(XYZ))).toEqual(["z", "x", "y"]);
  });

  it("follows arrival under FIFO", () => {
    expect(ids(build(XYZ, { policy: "fifo" }))).toEqual(["x", "y", "z"]);
  });

  it("caps the block at capacity", () => {
    expect(ids(build(XYZ, { capacity: 2 }))).toEqual(["z", "x"]);
    expect(build(XYZ, { capacity: 0 })).toEqual([]);
    expect(() => build(XYZ, { capacity: -1 })).toThrow();
  });

  it("leaves a nonce gap waiting and skips a used nonce", () => {
    expect(build([tx("y", "alice", 1)])).toEqual([]);
    expect(ids(build([tx("old", "alice", 0), tx("new", "alice", 1)], {}, () => 1))).toEqual(["new"]);
  });

  it("is reproducible from the seed under RANDOM", () => {
    const many = Array.from({ length: 12 }, (_, i) => tx(`t${i}`, `acct${i}`, 0));
    expect(ids(build(many, { policy: "random", seed: 5 }))).toEqual(ids(build(many, { policy: "random", seed: 5 })));
    expect(ids(build(many, { policy: "random", seed: 5 }))).not.toEqual(ids(build(many, { policy: "random", seed: 6 })));
  });

  it("ADVERSARIAL (placeholder) puts the front right before its victim and the back right after", () => {
    const victim = tx("victim", "noise-1", 0);
    const other = tx("other", "noise-2", 0);
    const front = tx("front", "sandwich-1", 0);
    const back = { ...tx("back", "sandwich-1", 1), side: "buy" as const };
    const block = build([other, victim, front, back], { policy: "adversarial", sandwichTargets: new Map([["front", "victim"]]) });
    expect(ids(block)).toEqual(["other", "front", "victim", "back"]);
  });
});
