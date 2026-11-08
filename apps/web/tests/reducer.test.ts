import { describe, expect, it } from "vitest";
import { SCALE, type Envelope, type EventFrame, type Frame, type SnapshotFrame, type Tx } from "../lib/contract";
import { MockSimulation } from "../lib/mock/sim";
import { fromSnapshot, initialState, reduce, type ArenaState } from "../lib/reducer";

// ---- a tiny hand-written world ----------------------------------------------------------------------

const S = (whole: number) => (BigInt(whole) * SCALE).toString();

function snapshot(overrides: Partial<SnapshotFrame> = {}): SnapshotFrame {
  return {
    kind: "snapshot",
    simulation: { status: "running", height: 5, policy: "fifo", seed: 1, capacity: 12, blockIntervalMs: 3000, nextBlockAt: null },
    market: {
      marketId: "eth-usdc",
      baseAsset: "ETH",
      quoteAsset: "USDC",
      baseReserve: S(1_000),
      quoteReserve: S(1_000_000),
      feeBps: 30,
      price: S(1_000),
      version: 7,
    },
    mempool: [],
    recentBlocks: [],
    accounts: [
      { accountId: "noise-1", kind: "noise", startBase: S(100), startQuote: S(100_000), baseBalance: S(100), quoteBalance: S(100_000) },
    ],
    ...overrides,
  };
}

const tx: Tx = {
  id: "tx-1",
  idempotencyKey: "noise-1:0:5",
  accountId: "noise-1",
  nonce: 0,
  marketId: "eth-usdc",
  side: "sell",
  amountIn: S(10),
  minAmountOut: "0",
  priorityFee: "3",
  submittedAt: 5,
  expiresAt: 8,
};

let seq = 0;
function ev(body: Pick<Envelope, "eventType" | "payload">): EventFrame {
  seq += 1;
  const meta = { eventId: `e-${seq}`, eventVersion: 1, aggregateId: "eth-usdc", occurredAt: "2026-11-05T00:00:00Z", correlationId: "c", causationId: "c" };
  return { kind: "event", event: { ...meta, ...body } as Envelope };
}

const OUT = "9871580343970612988504"; // selling 10 ETH into 1000 x 1,000,000 at 30 bps

function blockSix(): Frame[] {
  return [
    ev({ eventType: "BlockProposed", payload: { height: 6, policy: "fifo", transactionIds: ["tx-1"] } }),
    ev({ eventType: "TransactionExecuted", payload: { transactionId: "tx-1", blockHeight: 6, position: 0, status: "executed", errorCode: null } }),
    ev({
      eventType: "SwapExecuted",
      payload: { transactionId: "tx-1", marketId: "eth-usdc", accountId: "noise-1", side: "sell", amountIn: S(10), amountOut: OUT, effectivePrice: "1", slippageBps: 128, feePaid: "1" },
    }),
    ev({
      eventType: "MarketPriceUpdated",
      payload: { marketId: "eth-usdc", price: "1", baseReserve: S(1_010), quoteReserve: (1_000_000n * SCALE - BigInt(OUT)).toString(), version: 8 },
    }),
    ev({ eventType: "BlockCommitted", payload: { height: 6, stateRoot: "abc", transactionIds: ["tx-1"], executed: 1, failed: 0 } }),
  ];
}

const apply = (state: ArenaState, frames: Frame[]) => frames.reduce(reduce, state);

describe("reducer", () => {
  it("ignores everything until the first snapshot", () => {
    const s = apply(initialState, [ev({ eventType: "TransactionAccepted", payload: { transaction: tx } })]);
    expect(s).toBe(initialState);
  });

  it("snapshot -> events -> re-snapshot", () => {
    let s = reduce(initialState, snapshot());
    expect(s.synced).toBe(true);
    expect(s.prices).toEqual([{ height: 5, price: S(1_000), referencePrice: null }]);

    s = reduce(s, ev({ eventType: "TransactionAccepted", payload: { transaction: tx } }));
    expect(s.mempool.map((t) => t.id)).toEqual(["tx-1"]);

    s = apply(s, blockSix());
    expect(s.mempool).toEqual([]); // executed transactions leave the mempool
    expect(s.simulation?.height).toBe(6);
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0].receipts[0]).toMatchObject({ transactionId: "tx-1", accountId: "noise-1", side: "sell", amountOut: OUT, slippageBps: 128 });
    expect(s.accounts["noise-1"].base).toBe(90n * SCALE);
    expect(s.accounts["noise-1"].quote).toBe(100_000n * SCALE + BigInt(OUT));
    expect(s.market?.version).toBe(8);
    expect(s.prices.map((p) => p.height)).toEqual([5, 6]);

    // A reconnect: the new snapshot replaces everything, nothing from before survives.
    const fresh = snapshot({ simulation: { ...snapshot().simulation, height: 40 }, mempool: [{ ...tx, id: "tx-99", nonce: 1 }] });
    const after = reduce(s, fresh);
    expect(after).toEqual(fromSnapshot(fresh, 2));
    expect(after.blocks).toEqual([]);
    expect(after.accounts["noise-1"].base).toBe(100n * SCALE);
    expect(after.snapshots).toBe(2);
  });

  it("drops redelivered events and block events already in the snapshot", () => {
    let s = reduce(initialState, snapshot({ mempool: [tx] }));
    const block = blockSix();
    s = apply(s, block);
    const once = s;
    s = apply(s, block); // at-least-once delivery: the same eventIds again
    expect(s).toBe(once);

    // A different eventId for a block at or below the current height is stale.
    s = reduce(s, ev({ eventType: "BlockProposed", payload: { height: 6, policy: "fifo", transactionIds: [] } }));
    expect(s.building).toBeNull();
    // A TransactionAccepted for a transaction already executed is stale too.
    s = reduce(s, ev({ eventType: "TransactionAccepted", payload: { transaction: tx } }));
    expect(s.mempool).toEqual([]);
  });

  it("prunes expired transactions at commit and replaces by (account, nonce)", () => {
    const old: Tx = { ...tx, id: "tx-old", expiresAt: 6 };
    let s = reduce(initialState, snapshot({ mempool: [old] }));
    s = reduce(s, ev({ eventType: "TransactionAccepted", payload: { transaction: { ...tx, id: "tx-new", nonce: 0, priorityFee: "9" } } }));
    expect(s.mempool.map((t) => t.id)).toEqual(["tx-new"]);

    s = reduce(s, ev({ eventType: "TransactionAccepted", payload: { transaction: { ...tx, id: "tx-late", accountId: "noise-2", expiresAt: 6 } } }));
    s = apply(s, [
      ev({ eventType: "BlockProposed", payload: { height: 6, policy: "fifo", transactionIds: [] } }),
      ev({ eventType: "BlockCommitted", payload: { height: 6, stateRoot: "x", transactionIds: [], executed: 0, failed: 0 } }),
    ]);
    // tx-late (expiresAt 6) can never be in block 7; tx-new (expiresAt 8) can.
    expect(s.mempool.map((t) => t.id)).toEqual(["tx-new"]);
  });

  it("a reducer that saw every event agrees with one that only saw a late snapshot", () => {
    const sim = new MockSimulation({ seed: 7, policy: "priority_fee", clock: () => 0 });
    const toFrame = (f: Frame) => JSON.parse(JSON.stringify(f)) as Frame;

    let live = reduce(initialState, toFrame(sim.snapshot(sim.simulationState("running", null))));
    for (let i = 0; i < 130; i++) {
      for (const f of sim.produceBlock()) live = reduce(live, toFrame(f));
      live = reduce(live, toFrame({ kind: "simulation", state: sim.simulationState("running", null) }));
    }
    const late = reduce(initialState, toFrame(sim.snapshot(sim.simulationState("running", null))));

    expect(late.blocks).toEqual(live.blocks);
    expect(late.mempool).toEqual(live.mempool);
    // info.baseBalance/quoteBalance are "as of the snapshot", so compare the running balances.
    const balances = (s: ArenaState) => Object.values(s.accounts).map((a) => [a.info.accountId, a.base, a.quote]);
    expect(balances(late)).toEqual(balances(live));
    expect({ ...late.market, referencePrice: null }).toEqual({ ...live.market, referencePrice: null });
    // The price history rebuilt from receipts equals the one collected from live MarketPriceUpdated events.
    expect(late.prices.map((p) => [p.height, p.price])).toEqual(live.prices.map((p) => [p.height, p.price]));
  });
});
