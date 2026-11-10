/**
 * The Python gateway's frames, as the UI will receive them.
 *
 * fixtures/wire-frames.json is written by apps/api/tests/test_wire.py from real engine output (one block,
 * height 5, PRIORITY_FEE): a snapshot after block 4, every event of block 5, and the new simulation state.
 * That Python test fails if the gateway's output no longer matches this file, and this test fails if the UI
 * can no longer parse or apply it. Together they pin the contract from both sides.
 */
import { describe, expect, it } from "vitest";
import { SCALE, parseFrame, type Frame } from "../lib/contract";
import { initialState, reduce, type ArenaState } from "../lib/reducer";
import fixture from "./fixtures/wire-frames.json";

const texts = fixture.map((f) => JSON.stringify(f));

function applyAll(frames: Frame[]): ArenaState {
  return frames.reduce(reduce, initialState);
}

describe("gateway frames (fixture from apps/api)", () => {
  it("every frame passes the contract checks", () => {
    for (const text of texts) expect(() => parseFrame(text)).not.toThrow();
  });

  const frames = texts.map(parseFrame);
  const eventTypes = frames.flatMap((f) => (f.kind === "event" ? [f.event.eventType] : []));

  it("covers every event type the reducer reads", () => {
    expect(new Set(eventTypes)).toEqual(
      new Set([
        "TransactionDropped",
        "TransactionAccepted",
        "TransactionRejected",
        "BlockProposed",
        "TransactionExecuted",
        "SwapExecuted",
        "MarketPriceUpdated",
        "BlockCommitted",
      ]),
    );
  });

  it("starts from the snapshot: two pending transactions at height 4", () => {
    const s = applyAll(frames.slice(0, 1));
    expect(s.simulation?.height).toBe(4);
    expect(s.mempool.map((t) => t.id)).toEqual(["4.0", "4.1"]);
  });

  it("drops the expired transaction before the block is proposed", () => {
    const upToProposed = frames.slice(0, 1 + eventTypes.indexOf("BlockProposed"));
    expect(applyAll(upToProposed).mempool.map((t) => t.id)).toEqual(["4.0", "5.0"]);
  });

  it("ends at block 5 with an empty pool, one executed and one failed", () => {
    const s = applyAll(frames);
    expect(s.simulation?.height).toBe(5);
    expect(s.mempool).toEqual([]);
    const block = s.blocks.at(-1);
    expect(block).toMatchObject({ height: 5, policy: "priority_fee", executed: 1, failed: 1 });
    expect(block?.receipts.map((r) => [r.transactionId, r.status, r.errorCode])).toEqual([
      ["5.0", "executed", null],
      ["4.0", "failed", "slippage"],
    ]);
    expect(s.rejections.byReason).toEqual({ stale_nonce: 1 });
  });

  it("moves the arbitrage bot's balance and the pool price by the swap", () => {
    const before = applyAll(frames.slice(0, 1));
    const after = applyAll(frames);
    expect(before.accounts["arb-0"].base - after.accounts["arb-0"].base).toBe(3n * SCALE);
    expect(after.accounts["arb-0"].quote).toBeGreaterThan(before.accounts["arb-0"].quote);
    expect(BigInt(after.market!.price)).toBeLessThan(BigInt(before.market!.price)); // a sell lowers it
  });

  it("applies each event once even if it is delivered twice", () => {
    const doubled = frames.flatMap((f): Frame[] => (f.kind === "event" ? [f, f] : [f]));
    expect(applyAll(doubled)).toEqual(applyAll(frames));
  });
});
