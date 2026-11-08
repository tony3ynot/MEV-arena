import { describe, expect, it } from "vitest";
import { parseFrame, type EventFrame, type Frame, type Policy } from "../lib/contract";
import { MockSimulation } from "../lib/mock/sim";

const FIXED_CLOCK = () => Date.UTC(2026, 10, 5, 12, 0, 0);

/** Run `blocks` blocks and return every frame, round-tripped through JSON + parseFrame like the real stream. */
function run(policy: Policy, blocks: number, seed = 42): { sim: MockSimulation; frames: Frame[] } {
  const sim = new MockSimulation({ seed, policy, clock: FIXED_CLOCK });
  const frames: Frame[] = [];
  for (let i = 0; i < blocks; i++) frames.push(...sim.produceBlock());
  return { sim, frames: frames.map((f) => parseFrame(JSON.stringify(f))) };
}

const events = (frames: Frame[]) => frames.filter((f): f is EventFrame => f.kind === "event").map((f) => f.event);

describe("mock simulation", () => {
  it("is deterministic: same seed + policy gives the same frames", () => {
    expect(run("priority_fee", 30).frames).toEqual(run("priority_fee", 30).frames);
    expect(run("random", 30).frames).toEqual(run("random", 30).frames);
  });

  it("differs by policy and by seed", () => {
    const roots = (frames: Frame[]) =>
      events(frames).flatMap((e) => (e.eventType === "BlockCommitted" ? [e.payload.stateRoot] : []));
    const base = roots(run("priority_fee", 20).frames);
    expect(roots(run("fifo", 20).frames)).not.toEqual(base);
    expect(roots(run("priority_fee", 20, 43).frames)).not.toEqual(base);
  });

  it("emits frames that pass the contract checks, in the per-block order of the contract", () => {
    const { frames } = run("priority_fee", 25);
    // run() already parsed every frame; now check the order inside each block.
    let phase: "idle" | "txs" | "price" = "idle";
    for (const e of events(frames)) {
      switch (e.eventType) {
        case "TransactionAccepted":
        case "TransactionRejected":
          expect(phase).toBe("idle");
          break;
        case "BlockProposed":
          expect(phase).toBe("idle");
          phase = "txs";
          break;
        case "TransactionExecuted":
        case "SwapExecuted":
          expect(phase).toBe("txs");
          break;
        case "MarketPriceUpdated":
          expect(phase).toBe("txs");
          phase = "price";
          break;
        case "BlockCommitted":
          expect(phase === "txs" || phase === "price").toBe(true);
          phase = "idle";
          break;
      }
    }
  });

  it("never puts a bad nonce into a block, and stays within capacity", () => {
    for (const policy of ["fifo", "priority_fee", "random", "adversarial"] as Policy[]) {
      const evs = events(run(policy, 40).frames);
      for (const e of evs) {
        if (e.eventType === "TransactionExecuted") expect(e.payload.errorCode).not.toBe("bad_nonce");
        if (e.eventType === "BlockProposed") expect(e.payload.transactionIds.length).toBeLessThanOrEqual(12);
      }
    }
  });

  it("produces sandwiches that make money under PRIORITY_FEE and lose it under FIFO", () => {
    const sandwichPnlQuote = (policy: Policy) => {
      const { sim } = run(policy, 60);
      const snap = sim.snapshot(sim.simulationState("paused", null));
      const bot = snap.accounts.find((a) => a.accountId === "sandwich-1")!;
      const price = BigInt(snap.market.price);
      return ((BigInt(bot.baseBalance) - BigInt(bot.startBase)) * price) / 10n ** 18n + BigInt(bot.quoteBalance) - BigInt(bot.startQuote);
    };
    expect(sandwichPnlQuote("priority_fee") > 0n).toBe(true);
    expect(sandwichPnlQuote("adversarial") > 0n).toBe(true);
    expect(sandwichPnlQuote("fifo") < 0n).toBe(true);
  });

  it("noise traders get the same random inputs under every policy", () => {
    // The first interval is planned before any block, so its submissions must match exactly.
    const firstAccepted = (policy: Policy) =>
      events(run(policy, 1).frames)
        .filter((e) => e.eventType === "TransactionAccepted")
        .map((e) => (e.eventType === "TransactionAccepted" ? e.payload.transaction : null));
    expect(firstAccepted("fifo")).toEqual(firstAccepted("random"));
  });
});
