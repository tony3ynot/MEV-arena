/**
 * MockSimulation: a deterministic, in-browser stand-in for the Python engine + gateway.
 *
 * It owns the world (one ETH/USDC pool, bot balances, nonces), a mempool, the bots and the builder, and it
 * produces exactly the frames the real gateway will send (lib/contract.ts). It has no timers; MockRunner
 * (runner.ts) decides when things happen. Same seed + policy => same sequence of transactions, blocks and
 * state roots, however the calls are spaced in time.
 *
 * Per block interval:
 *   1. right after a block commits, the bots look at the new state and plan this interval's submissions
 *      (arb bot first, then noise traders in a seeded order, the sandwich bot right behind its victim);
 *   2. the runner releases the planned submissions one by one (TransactionAccepted / TransactionRejected);
 *   3. produceBlock() releases anything left, builds, executes and commits the block.
 */
import type {
  AccountInfo,
  BlockSummary,
  EventFrame,
  Frame,
  Market,
  Policy,
  Receipt,
  RejectReason,
  SimulationState,
  SimulationStatus,
  SnapshotFrame,
  Tx,
} from "../contract";
import { SCALE } from "../contract";
import { spotPrice } from "./amm";
import { buildBlock } from "./builder";
import {
  ARB_ID,
  SANDWICH_ID,
  arbIntent,
  drawNoise,
  initialAccounts,
  nextReferencePrice,
  noiseIntent,
  sandwichPlan,
  type AccountSetup,
  type Intent,
} from "./bots";
import { balanceOf, canonicalJson, executeTx, nextNonce, type MockReceipt, type MockTx, type World } from "./execution";
import { fnv1a, mockHash, rngFor } from "./rng";

export const MOCK_DEFAULTS = {
  seed: 42,
  policy: "priority_fee" as Policy,
  capacity: 12,
  blockIntervalMs: 3_000,
  /** The mock rejects with "pool_full" instead of evicting the cheapest (ADR-0009): the contract has no event for an eviction yet. */
  poolMaxSize: 64,
  /** How many recent blocks the mock keeps and sends in a snapshot. */
  recentBlocks: 100,
};

export const MARKET_ID = "eth-usdc";

export interface MockOptions {
  seed: number;
  policy: Policy;
  /** Bumped by every replay so event ids never repeat inside one browser tab. */
  epoch?: number;
  /** Wall clock for occurredAt only. Tests pass a fixed one. */
  clock?: () => number;
  capacity?: number;
  blockIntervalMs?: number;
}

/** A submission planned for this interval. */
interface Planned {
  tx: Omit<MockTx, "id">;
  /** For a sandwich front: index of its victim in the plan. */
  victimIndex: number | null;
}

export class MockSimulation {
  readonly seed: number;
  readonly policy: Policy;
  readonly capacity: number;
  readonly blockIntervalMs: number;
  /** Last committed block height. */
  height = 0;

  private readonly epoch: number;
  private readonly clock: () => number;
  private readonly accounts: AccountSetup[];
  private readonly world: World;
  /** The arb bot's reference price as of the last committed block, and the one it aims at for the next. */
  private referenceCommitted: bigint;
  private referenceNext: bigint;
  /** Pending transactions in arrival order. */
  private mempool: MockTx[] = [];
  private planned: Planned[] = [];
  private nextPlanned = 0;
  /** planned index -> transaction id it got, or null if it was rejected. */
  private plannedIds: (string | null)[] = [];
  private blocks: BlockSummary[] = [];
  /** sandwich front id -> victim id; known to the bot, and to the ADVERSARIAL placeholder builder. Never on the wire. */
  private readonly sandwichTargets = new Map<string, string>();
  private txSeq = 0;
  private eventSeq = 0;

  constructor(options: MockOptions) {
    this.seed = options.seed;
    this.policy = options.policy;
    this.epoch = options.epoch ?? 0;
    this.clock = options.clock ?? (() => Date.now());
    this.capacity = options.capacity ?? MOCK_DEFAULTS.capacity;
    this.blockIntervalMs = options.blockIntervalMs ?? MOCK_DEFAULTS.blockIntervalMs;
    this.accounts = initialAccounts();
    this.world = {
      pool: {
        marketId: MARKET_ID,
        baseAsset: "ETH",
        quoteAsset: "USDC",
        baseReserve: 1_000n * SCALE,
        quoteReserve: 1_000_000n * SCALE,
        feeBps: 30,
        version: 0,
      },
      balances: new Map(this.accounts.map((a) => [a.accountId, { base: a.startBase, quote: a.startQuote }])),
      nonces: new Map(),
    };
    this.referenceCommitted = spotPrice(this.world.pool);
    this.referenceNext = nextReferencePrice(this.referenceCommitted, rngFor(this.seed, "reference", 1));
    this.planInterval();
  }

  // ---- what the runner calls ---------------------------------------------------------------------------

  /** Submissions planned for this interval and not yet released. */
  get pendingArrivals(): number {
    return this.planned.length - this.nextPlanned;
  }

  /** Release the next planned submission into the mempool. */
  emitNextArrival(): Frame[] {
    if (this.nextPlanned >= this.planned.length) return [];
    const index = this.nextPlanned++;
    const { tx, victimIndex } = this.planned[index];
    const { id, frame } = this.admit(tx);
    this.plannedIds[index] = id;
    if (id !== null && victimIndex !== null) {
      const victimId = this.plannedIds[victimIndex];
      if (victimId) this.sandwichTargets.set(id, victimId);
    }
    return [frame];
  }

  /** Release every remaining planned submission. */
  flushArrivals(): Frame[] {
    const frames: Frame[] = [];
    while (this.pendingArrivals > 0) frames.push(...this.emitNextArrival());
    return frames;
  }

  /** Build, execute and commit the next block, then let the bots plan the interval after it. */
  produceBlock(): Frame[] {
    const frames = this.flushArrivals();
    const world = this.world;
    const height = this.height + 1;
    const txs = buildBlock(this.mempool, (account) => nextNonce(world, account), {
      policy: this.policy,
      capacity: this.capacity,
      seed: fnv1a(`${this.seed}|block|${height}`),
      sandwichTargets: this.sandwichTargets,
    });
    const transactionIds = txs.map((t) => t.id);

    const proposed = this.meta();
    frames.push(event({ ...proposed, eventType: "BlockProposed", payload: { height, policy: this.policy, transactionIds } }));

    const receipts: Receipt[] = [];
    let executed = 0;
    txs.forEach((tx, position) => {
      const r = executeTx(world, tx, position);
      const executedMeta = this.meta(proposed.eventId, proposed.eventId);
      frames.push(
        event({
          ...executedMeta,
          eventType: "TransactionExecuted",
          payload: { transactionId: tx.id, blockHeight: height, position, status: r.status, errorCode: r.errorCode },
        }),
      );
      if (r.status === "executed") {
        executed += 1;
        frames.push(
          event({
            ...this.meta(proposed.eventId, executedMeta.eventId),
            eventType: "SwapExecuted",
            payload: {
              transactionId: tx.id,
              marketId: tx.marketId,
              accountId: tx.accountId,
              side: tx.side,
              amountIn: tx.amountIn.toString(),
              amountOut: r.amountOut.toString(),
              effectivePrice: r.effectivePrice.toString(),
              slippageBps: r.slippageBps,
              feePaid: r.feePaid.toString(),
            },
          }),
        );
      }
      receipts.push(toWireReceipt(r));
    });
    const included = new Set(transactionIds);
    this.mempool = this.mempool.filter((t) => !included.has(t.id));
    this.referenceCommitted = this.referenceNext;

    if (executed > 0) {
      const pool = world.pool;
      frames.push(
        event({
          ...this.meta(proposed.eventId, proposed.eventId),
          eventType: "MarketPriceUpdated",
          payload: {
            marketId: pool.marketId,
            price: spotPrice(pool).toString(),
            baseReserve: pool.baseReserve.toString(),
            quoteReserve: pool.quoteReserve.toString(),
            version: pool.version,
            referencePrice: this.referenceCommitted.toString(),
          },
        }),
      );
    }

    const stateRoot = mockHash(canonicalJson(world));
    const failed = txs.length - executed;
    frames.push(
      event({
        ...this.meta(proposed.eventId, proposed.eventId),
        eventType: "BlockCommitted",
        payload: { height, stateRoot, transactionIds, executed, failed },
      }),
    );
    this.blocks.push({ height, policy: this.policy, transactionIds, executed, failed, stateRoot, receipts });
    if (this.blocks.length > MOCK_DEFAULTS.recentBlocks) this.blocks.shift();
    this.height = height;

    // Drop what can never be included again: at the next block (height + 1) a transaction is expired when
    // expiresAt < height + 1 (ADR-0010). The stream announces nothing; the reducer applies the same rule.
    this.mempool = this.mempool.filter((t) => t.expiresAt > height);
    for (const frontId of [...this.sandwichTargets.keys()]) {
      if (!this.mempool.some((t) => t.id === frontId)) this.sandwichTargets.delete(frontId);
    }
    this.referenceNext = nextReferencePrice(this.referenceCommitted, rngFor(this.seed, "reference", height + 1));
    this.planInterval();
    return frames;
  }

  simulationState(status: SimulationStatus, nextBlockAtMs: number | null): SimulationState {
    return {
      status,
      height: this.height,
      policy: this.policy,
      seed: this.seed,
      capacity: this.capacity,
      blockIntervalMs: this.blockIntervalMs,
      nextBlockAt: nextBlockAtMs === null ? null : new Date(nextBlockAtMs).toISOString(),
    };
  }

  snapshot(simulation: SimulationState): SnapshotFrame {
    const pool = this.world.pool;
    const market: Market = {
      marketId: pool.marketId,
      baseAsset: pool.baseAsset,
      quoteAsset: pool.quoteAsset,
      baseReserve: pool.baseReserve.toString(),
      quoteReserve: pool.quoteReserve.toString(),
      feeBps: pool.feeBps,
      price: spotPrice(pool).toString(),
      version: pool.version,
      referencePrice: this.referenceCommitted.toString(),
    };
    const accounts: AccountInfo[] = this.accounts.map((a) => {
      const balance = balanceOf(this.world, a.accountId);
      return {
        accountId: a.accountId,
        kind: a.kind,
        startBase: a.startBase.toString(),
        startQuote: a.startQuote.toString(),
        baseBalance: balance.base.toString(),
        quoteBalance: balance.quote.toString(),
      };
    });
    return {
      kind: "snapshot",
      simulation,
      market,
      mempool: this.mempool.map(toWireTx),
      recentBlocks: this.blocks.map((b) => ({ ...b, transactionIds: [...b.transactionIds], receipts: [...b.receipts] })),
      accounts,
    };
  }

  // ---- bots ---------------------------------------------------------------------------------------------

  private planInterval(): void {
    const height = this.height;
    const world = this.world;
    const pool = world.pool;
    const plan: Planned[] = [];
    const add = (intent: Intent, nonce: number, victimIndex: number | null = null): Planned => ({
      tx: {
        idempotencyKey: `${intent.accountId}:${nonce}:${height}`,
        accountId: intent.accountId,
        nonce,
        marketId: MARKET_ID,
        side: intent.side,
        amountIn: intent.amountIn,
        minAmountOut: intent.minAmountOut,
        priorityFee: intent.priorityFee,
        submittedAt: height,
        expiresAt: height + intent.ttlBlocks,
      },
      victimIndex,
    });
    const hasPending = (accountId: string) => this.mempool.some((t) => t.accountId === accountId);

    // 1. The arbitrage bot reacts to the new block first.
    if (!hasPending(ARB_ID)) {
      const intent = arbIntent(pool, this.referenceNext, balanceOf(world, ARB_ID));
      if (intent) plan.push(add(intent, nextNonce(world, ARB_ID)));
    }

    // 2. Noise traders, in a seeded arrival order. Their draws do not depend on the policy, so a replay under
    //    another policy sees the same noise inputs.
    const noiseIds = this.accounts.filter((a) => a.kind === "noise").map((a) => a.accountId);
    for (const accountId of rngFor(this.seed, "arrival", height).shuffle(noiseIds)) {
      const draw = drawNoise(rngFor(this.seed, "noise", height, accountId));
      const pending = this.mempool.find((t) => t.accountId === accountId);
      if (pending) {
        // One transaction in flight per trader keeps its nonces gap-free. Now and then its client retries
        // the same submission, which the mempool turns away as a duplicate.
        if (draw.retry) plan.push({ tx: withoutId(pending), victimIndex: null });
        continue;
      }
      if (draw.wants) plan.push(add(noiseIntent(accountId, draw, pool), nextNonce(world, accountId)));
    }

    // 3. The sandwich bot watches the arrivals and wraps the first one worth it: front right behind the victim
    //    (nonce n, fee + 1), back right after (nonce n + 1, fee - 1).
    if (!hasPending(SANDWICH_ID)) {
      const isRetry = (p: Planned) => this.mempool.some((t) => t.idempotencyKey === p.tx.idempotencyKey);
      for (let i = 0; i < plan.length; i++) {
        const victim = plan[i];
        if (victim.tx.accountId === SANDWICH_ID || isRetry(victim)) continue;
        const sandwich = sandwichPlan(pool, victim.tx, balanceOf(world, SANDWICH_ID));
        if (!sandwich) continue;
        const nonce = nextNonce(world, SANDWICH_ID);
        plan.splice(i + 1, 0, add(sandwich.front, nonce, i), add(sandwich.back, nonce + 1));
        break;
      }
    }

    this.planned = plan;
    this.nextPlanned = 0;
    this.plannedIds = [];
  }

  // ---- mempool admission (a simplified copy of the engine's Mempool.add) ---------------------------------

  private admit(tx: Omit<MockTx, "id">): { id: string | null; frame: EventFrame } {
    const reject = (reason: RejectReason) => ({
      id: null,
      frame: event({
        ...this.meta(),
        eventType: "TransactionRejected",
        payload: { idempotencyKey: tx.idempotencyKey, accountId: tx.accountId, reason },
      }),
    });

    const sameKey = this.mempool.find((t) => t.idempotencyKey === tx.idempotencyKey);
    if (sameKey) return reject(samePayload(sameKey, tx) ? "duplicate" : "conflict");
    if (tx.expiresAt < this.height + 1) return reject("expired");
    if (tx.nonce < nextNonce(this.world, tx.accountId)) return reject("stale_nonce");
    const occupant = this.mempool.find((t) => t.accountId === tx.accountId && t.nonce === tx.nonce);
    if (occupant) {
      if (tx.priorityFee <= occupant.priorityFee) return reject("underpriced");
      this.mempool = this.mempool.filter((t) => t !== occupant); // replaced; the reducer drops it by (account, nonce)
    } else if (this.mempool.length >= MOCK_DEFAULTS.poolMaxSize) {
      return reject("pool_full");
    }

    this.txSeq += 1;
    const accepted: MockTx = { id: `tx-${String(this.txSeq).padStart(6, "0")}`, ...tx };
    this.mempool.push(accepted);
    return { id: accepted.id, frame: event({ ...this.meta(), eventType: "TransactionAccepted", payload: { transaction: toWireTx(accepted) } }) };
  }

  // ---- envelopes ---------------------------------------------------------------------------------------

  /** Common envelope fields. Ids look like UUIDs and are deterministic: seed/policy, epoch, sequence. */
  private meta(correlationId?: string, causationId?: string) {
    this.eventSeq += 1;
    const eventId = [
      fnv1a(`${this.seed}|${this.policy}`).toString(16).padStart(8, "0"),
      (this.epoch & 0xffff).toString(16).padStart(4, "0"),
      "4000",
      "8000",
      this.eventSeq.toString(16).padStart(12, "0"),
    ].join("-");
    return {
      eventId,
      eventVersion: 1,
      aggregateId: MARKET_ID,
      occurredAt: new Date(this.clock()).toISOString(),
      correlationId: correlationId ?? eventId,
      causationId: causationId ?? correlationId ?? eventId,
    };
  }
}

function event(e: EventFrame["event"]): EventFrame {
  return { kind: "event", event: e };
}

function withoutId(tx: MockTx): Omit<MockTx, "id"> {
  const { id: _id, ...rest } = tx;
  void _id;
  return rest;
}

function samePayload(a: Omit<MockTx, "id">, b: Omit<MockTx, "id">): boolean {
  return (
    a.accountId === b.accountId &&
    a.nonce === b.nonce &&
    a.side === b.side &&
    a.amountIn === b.amountIn &&
    a.minAmountOut === b.minAmountOut &&
    a.priorityFee === b.priorityFee &&
    a.expiresAt === b.expiresAt
  );
}

function toWireTx(tx: MockTx): Tx {
  return {
    id: tx.id,
    idempotencyKey: tx.idempotencyKey,
    accountId: tx.accountId,
    nonce: tx.nonce,
    marketId: tx.marketId,
    side: tx.side,
    amountIn: tx.amountIn.toString(),
    minAmountOut: tx.minAmountOut.toString(),
    priorityFee: tx.priorityFee.toString(),
    submittedAt: tx.submittedAt,
    expiresAt: tx.expiresAt,
  };
}

function toWireReceipt(r: MockReceipt): Receipt {
  return {
    transactionId: r.tx.id,
    accountId: r.tx.accountId,
    position: r.position,
    status: r.status,
    side: r.tx.side,
    amountIn: r.tx.amountIn.toString(),
    amountOut: r.amountOut.toString(),
    slippageBps: r.slippageBps,
    errorCode: r.errorCode,
  };
}
