/**
 * Block building, a TypeScript copy of packages/simulation-engine/.../block_builder (ADR-0011).
 *
 * Every policy shares one skeleton: each account's transactions form a queue in nonce order, and only a queue
 * head carrying the account's next nonce may go in. The policy only decides which eligible head goes first.
 * Whatever is not picked stays in the mempool for the next block.
 */
import type { Policy } from "../contract";
import type { MockTx } from "./execution";
import { Rng } from "./rng";

export interface BuildOptions {
  policy: Policy;
  capacity: number;
  /** Matters only to RANDOM; derived per block from the simulation seed. */
  seed: number;
  /**
   * Mock-only knowledge for the ADVERSARIAL placeholder: sandwich front id -> victim id, told to the builder
   * by the sandwich bot. A real adversarial builder would have to infer it.
   */
  sandwichTargets?: ReadonlyMap<string, string>;
}

/**
 * Pick up to `capacity` transactions from `candidates` (arrival order) and return them in execution order.
 * `nextNonce(account)` is the account's next expected nonce in the world state.
 */
export function buildBlock(candidates: readonly MockTx[], nextNonce: (accountId: string) => number, options: BuildOptions): MockTx[] {
  const { policy, capacity, seed } = options;
  if (capacity < 0) throw new Error(`capacity must be non-negative, got ${capacity}`);
  const rank = rankOf(policy === "adversarial" ? "fifo" : policy, candidates, seed);

  // Each account's transactions, lowest nonce first.
  const queues = new Map<string, MockTx[]>();
  for (const tx of [...candidates].sort((a, b) => a.nonce - b.nonce)) {
    const queue = queues.get(tx.accountId) ?? [];
    queue.push(tx);
    queues.set(tx.accountId, queue);
  }
  const expected = new Map<string, number>();
  for (const account of queues.keys()) expected.set(account, nextNonce(account));

  const heads: MockTx[] = [];
  const offerHead = (account: string) => {
    const queue = queues.get(account)!;
    const want = expected.get(account)!;
    while (queue.length > 0 && queue[0].nonce < want) queue.shift(); // nonce already used; can never execute
    if (queue.length > 0 && queue[0].nonce === want) heads.push(queue.shift()!);
  };
  for (const account of queues.keys()) offerHead(account);

  const block: MockTx[] = [];
  while (heads.length > 0 && block.length < capacity) {
    // The eligible head the policy likes best (lowest rank). The Python engine keeps a heap; with a few dozen
    // candidates a scan is simpler and gives the same block, because ranks are unique.
    let best = 0;
    for (let i = 1; i < heads.length; i++) {
      if (rank.get(heads[i].id)! < rank.get(heads[best].id)!) best = i;
    }
    const [tx] = heads.splice(best, 1);
    block.push(tx);
    expected.set(tx.accountId, tx.nonce + 1);
    offerHead(tx.accountId);
  }

  if (policy === "adversarial") return sandwichAroundVictims(block, options.sandwichTargets ?? new Map());
  return block;
}

/** tx id -> place in the policy's preference order, 0 first. Arrival breaks every tie. */
function rankOf(policy: Exclude<Policy, "adversarial">, candidates: readonly MockTx[], seed: number): Map<string, number> {
  const arrival = candidates.map((_, i) => i);
  let order: number[];
  switch (policy) {
    case "fifo":
      order = arrival;
      break;
    case "priority_fee":
      order = [...arrival].sort((a, b) => {
        const fa = candidates[a].priorityFee;
        const fb = candidates[b].priorityFee;
        if (fa !== fb) return fa > fb ? -1 : 1; // higher fee first
        return a - b;
      });
      break;
    case "random": {
      const rng = new Rng(seed); // a private generator for this block
      const draws = arrival.map(() => rng.next());
      order = [...arrival].sort((a, b) => draws[a] - draws[b] || a - b);
      break;
    }
  }
  const rank = new Map<string, number>();
  order.forEach((index, place) => rank.set(candidates[index].id, place));
  return rank;
}

/**
 * ADVERSARIAL - PLACEHOLDER, mock only. ADR-0011 left "adversarial" undefined; this is one guess.
 * Take the FIFO block, then move each sandwich front to just before its victim and the back to just after.
 * If the move would break any account's nonce order, keep the FIFO block.
 */
function sandwichAroundVictims(block: MockTx[], targets: ReadonlyMap<string, string>): MockTx[] {
  let order = [...block];
  for (const [frontId, victimId] of targets) {
    const front = order.find((t) => t.id === frontId);
    const victim = order.find((t) => t.id === victimId);
    if (!front || !victim) continue;
    const back = order.find((t) => t.accountId === front.accountId && t.nonce === front.nonce + 1);
    order = order.filter((t) => t !== front && t !== back);
    const at = order.indexOf(victim);
    order.splice(at, 0, front); // front right before the victim
    if (back) order.splice(at + 2, 0, back); // back right after it
  }
  return keepsNonceOrder(order) ? order : block;
}

function keepsNonceOrder(order: MockTx[]): boolean {
  const last = new Map<string, number>();
  for (const tx of order) {
    if ((last.get(tx.accountId) ?? -1) >= tx.nonce) return false;
    last.set(tx.accountId, tx.nonce);
  }
  return true;
}
