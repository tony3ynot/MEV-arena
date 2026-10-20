# 0011. Every builder policy merges per-account nonce queues; the policy only ranks the heads

- Status: Accepted
- Date: 2026-10-21
- Related: spec §5 (capacity), §8 Block Builder, ADR-0006, ADR-0007, ADR-0010

## Context

The execution engine (ADR-0007) runs a transaction only if its nonce equals the account's next nonce;
otherwise it fails with `BAD_NONCE`, which consumes no nonce but still takes a place in the block.

Sorting candidates by the policy alone breaks this. With alice's nonce 0 at fee 1, her nonce 1 at fee 5, and
bob's nonce 0 at fee 3, a plain fee sort gives `alice#1, bob#0, alice#0`: the transaction that paid the most is
the one that fails. FIFO breaks the same way if an account's nonce 1 arrives before its nonce 0, and a random
shuffle breaks it all the time.

Block capacity is a transaction count (spec §5). Every transaction is the same kind of swap, so a gas-like weight
would be the count times a constant.

## Options considered

1. Order by the policy alone and let execution fail the misplaced ones. Simplest / wastes block space and
   punishes the highest bidders, which distorts every comparison between policies
2. Each account's transactions form a queue in nonce order; only a head carrying the account's next nonce may
   enter; the policy decides which head goes first (what geth's block producer does). Every block executes
   cleanly / the builder needs each account's next nonce

## Decision

Option 2, as one shared skeleton for every policy: `build_block(candidates, next_nonce, policy=, capacity=,
seed=)`. A policy is reduced to a ranking of candidates, with arrival breaking every tie, and a min-heap of
eligible heads does the merge. This extends ADR-0006's "(candidates, capacity, seed)" with `next_nonce`, passed as
a callable (`WorldState.next_nonce`) so the builder does not import execution.

- FIFO ranks by arrival; PRIORITY_FEE by fee, then arrival; RANDOM by draws from `random.Random(seed)`, a
  private generator.
- A nonce gap leaves the account's later transactions in the mempool for a later block. A nonce already used is
  skipped.
- The builder never touches the mempool. Carry-over is simply that unpicked transactions are still there next
  block.
- ADVERSARIAL is not built yet. It needs its own decision on what "adversarial" means, tied to the week-4 bots.

## Consequences

- Gain: a built block never contains a `BAD_NONCE`; policies differ only in what they are meant to differ in
- Accept: a high fee cannot pull an account's later transaction ahead of its own earlier one
- Accept: O(n log n) per block for the ranking and the heap
- Revisit if transactions ever get different weights (then capacity becomes a sum, and the greedy merge needs
  rethinking)
