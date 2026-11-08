import { describe, expect, it } from "vitest";
import { SCALE, parseFrame, type AccountKind, type Receipt } from "../lib/contract";
import { blockSandwiches, slippageStats } from "../lib/derive";
import { formatUnits } from "../lib/format";

const kind = (id: string) => id.split("-")[0] as AccountKind;
const r = (transactionId: string, accountId: string, position: number, side: "buy" | "sell", status: "executed" | "failed" = "executed"): Receipt => ({
  transactionId,
  accountId,
  position,
  status,
  side,
  amountIn: "1",
  amountOut: "1",
  slippageBps: 0,
  errorCode: status === "failed" ? "slippage" : null,
});

describe("formatting", () => {
  it("keeps BigInt precision and rounds half away from zero", () => {
    expect(formatUnits(1_234_567_890_123_456_789_012n, 4)).toBe("1,234.5679");
    expect(formatUnits(-15n * 10n ** 15n, 2)).toBe("−0.02"); // -0.015 -> -0.02
    expect(formatUnits(4n * 10n ** 15n, 2)).toBe("0.00"); // no "-0.00" / "+0.00"
    expect(formatUnits(SCALE, 2, true)).toBe("+1.00");
    expect(formatUnits(98_710_000_000_000_000_000_000_000n, 2)).toBe("98,710,000.00");
  });
});

describe("slippage stats", () => {
  it("mean and nearest-rank p95", () => {
    expect(slippageStats([])).toEqual({ count: 0, meanBps: null, p95Bps: null });
    const values = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
    expect(slippageStats(values)).toEqual({ count: 20, meanBps: 10.5, p95Bps: 19 });
  });
});

describe("sandwich detection", () => {
  it("links front -> victim -> back in execution order", () => {
    const tags = blockSandwiches(
      [r("a", "noise-2", 0, "buy"), r("f", "sandwich-1", 1, "sell"), r("v", "noise-1", 2, "sell"), r("b", "sandwich-1", 3, "buy")],
      kind,
    );
    expect(Object.fromEntries([...tags].map(([id, t]) => [id, t.role]))).toEqual({ f: "front", v: "victim", b: "back" });
  });

  it("does not call it a sandwich when the victim lands first (FIFO) or reverted", () => {
    expect(blockSandwiches([r("v", "noise-1", 0, "sell"), r("f", "sandwich-1", 1, "sell"), r("b", "sandwich-1", 2, "buy")], kind).size).toBe(0);
    expect(blockSandwiches([r("f", "sandwich-1", 0, "sell"), r("v", "noise-1", 1, "sell", "failed"), r("b", "sandwich-1", 2, "buy")], kind).size).toBe(0);
  });
});

describe("contract parsing", () => {
  it("rejects an amount sent as a JSON number", () => {
    const frame = { kind: "event", event: { eventId: "e", eventType: "BlockCommitted", eventVersion: 1, aggregateId: "m", occurredAt: "t", correlationId: "c", causationId: "c", payload: { height: 1, stateRoot: "x", transactionIds: [], executed: 0, failed: 0 } } };
    expect(() => parseFrame(JSON.stringify(frame))).not.toThrow();
    const bad = { ...frame, event: { ...frame.event, eventType: "MarketPriceUpdated", payload: { marketId: "m", price: 1000, baseReserve: "1", quoteReserve: "1", version: 1 } } };
    expect(() => parseFrame(JSON.stringify(bad))).toThrow(/price/);
  });
});
