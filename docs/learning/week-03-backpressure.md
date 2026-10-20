# Week 03 — Mempool, block builder, backpressure

> Learning notes. Code: `packages/simulation-engine` (`mempool`, `block_builder`); experiment and raw tables:
> [experiments/week-03-backpressure](../../experiments/week-03-backpressure/README.md).
> Decisions: [ADR-0008](../decisions/0008-gateway-assigns-transaction-ids.md),
> [0009](../decisions/0009-full-mempool-evicts-cheapest.md), [0010](../decisions/0010-expiry-rule-and-candidate-set.md),
> [0011](../decisions/0011-builder-nonce-queues.md).

## Question for the week

- What does a mempool have to promise so the block builder can trust it, and how do you test those promises?
- Can a builder order by fee, randomness, or arrival without ever producing a transaction that fails on its nonce?
- When producers outrun the block producer, what does bounding the pool buy, and what does it cost?
  (carried from week 1: does a bounded queue break "deep backlog → long loop iteration"?)

## Predictions

| Question | Predicted | Actual |
|---|---|---|
| Same idempotency key as a pooled transaction, higher fee, same (account, nonce) | `REPLACED` | `CONFLICT`: the key is checked first, so the fee is never compared |
| Unit of block capacity | transaction count | count; spec §5 says the same |
| At 2.5·C, which pool has the worst submit p99? | unbounded, "it grows, so the work gets heavier" | unbounded was the *best* for 30 s; both bounded pools timed out |

## Results

### Mempool and builder

- Admission is a chain of verdicts: idempotency key → id clash → expiry → nonce → (account, nonce) replacement →
  capacity. `add()` returns the verdict and the id it evicted, if any.
- A hypothesis state machine (random `add` / `remove` / next block, checking after every step that the verdict
  matches what visibly changed) found a bug in two steps: a reused id under a different key silently overwrote
  the pooled transaction and left dangling index entries. Ids are gateway-assigned, so that is now an exception.
- With three idempotency keys in the generator, `REPLACED` ran 3 times in ≈ 2,000 steps. Widening to eight keys
  and six ids brought every verdict to dozens of hits.
- A `<` → `<=` mutant in the expiry rule passed the state machine (it uses the same rule as its oracle) and failed
  two example tests that pin the boundary.
- The builder merges per-account nonce queues with a heap; the policy only ranks the heads. Four mutants
  (plain sort, flipped tie, no stale-nonce skip, one pick per account) all failed the tests.

### Backpressure experiment (C = 400 tx/s, 30 s per stage)

| At 2.5·C (1,000/s) | Submit p99 | Timed out | Meanwhile |
|---|---|---|---|
| Unbounded | 0.85–1.2 s | 0 % (3 runs) | depth 22,000 and rising; inclusion fell from 400/s to 62–120/s |
| 10,000 | 2 s | 49–50 % (3 runs) | collapsed the moment it filled |
| 1,000 | 2 s | 15–71 % (4 runs) | near the loop's limit, outcome varied run to run |

At 1.5·C the 1,000 pool was clearly best: p99 28 ms against 162–173 ms. The overload was paid by low fees
(mean fee shed 15, included 68).

## What I learned

1. **A verdict is a contract.** Each admission verdict promises an observable change: `ACCEPTED` grows the pool by
   exactly one, every rejection leaves it untouched. Testing "verdict = what changed" over random sequences found
   a bug that no example test covered. Client mistakes get verdicts; our own bugs get exceptions, so they cannot
   hide among ordinary rejections.
2. **Count what a property test actually exercises.** A passing test with three keys almost never reached the
   replacement path. And different tests guard different things: the state machine checks that operations stay
   consistent with each other, example tests pin boundaries such as "valid through `expires_at`".
3. **A fee sort is not a block.** Sorting by fee put alice's nonce 1 ahead of her nonce 0, so the transaction
   that paid the most failed. Per-account queues plus "only heads compete" fixes it for every policy at once,
   and reduces a policy to a ranking.
4. **An unbounded queue fails late, and somewhere else.** For 30 s the producers saw nothing wrong, while the
   consumer slowed from 400/s to 62/s because every block sorted the whole pool. Little's law with a capacity
   that shrinks as the queue grows is a spiral. The bill arrives as waiting time (30–44 s for low fees) and,
   given a bit longer, as collapse.
5. **A bound is only as good as its enforcement cost.** Evicting the cheapest by scanning the whole pool costs
   2.4 ms per submission at 10,000. The bound kept memory flat and pushed CPU past 100 %. Bounded memory is not
   the same as bounded work; the eviction needs an O(log n) structure.
6. **Near a ceiling, one run is an anecdote.** The same condition timed out 15 %, 34 %, 15 % and 71 %. Once requests
   time out, reconnects add load and the server does not come back: a metastable failure. Repeat runs, and read
   the spread.
7. **Control first, and check who is answering.** The first attempt measured the HTTP layer's ceiling (≈ 1,500
   POST/s on one loop), not the pool, because there was no control run. Later, a server left over from an earlier
   run answered three runs. Week 1's lesson 7 again: the harness needs as much care as the system.

## Questions carried to next week

- Make eviction O(log n) (a heap keyed by fee and arrival, lazy deletion) and repeat the 2.5·C stage. Does a cheap
  bound beat unbounded on every metric?
- `candidates()` sorts the pool every block. Keep it ordered incrementally, or cap how much the builder looks at?
- The adversarial policy: define it together with the week-4 sandwich bot.
- True backpressure: producers that back off on `429` instead of an open model that ignores it.
- One FastAPI loop tops out near 1,500 POST/s, against a 5,000 tx/s target (spec §14). Where does the gateway's
  time go, and how many workers does it need?
- Still open from week 2: copy state once per block instead of once per transaction.

## References

- Spec §5 (block capacity), §8 Mempool and Block Builder, §14 targets, §15 load tests
- geth transaction pool: price-based eviction, pending vs queued (future nonces)
- Hypothesis stateful testing (`RuleBasedStateMachine`)
- Bronson et al., "Metastable Failures in Distributed Systems", HotOS 2021
