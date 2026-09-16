# Week 02 — AMM and deterministic execution

> Learning notes. Code: `packages/simulation-engine` (`models`, `amm`, `execution`, `events`); numbers below come
> from `uv run pytest packages/simulation-engine -s -k sandwich`. Decisions: [ADR-0007](../decisions/0007-amm-and-execution-semantics.md).

## Question for the week

- Does transaction *order* alone change what a constant-product AMM executes, and by how much?
- Can "same snapshot + same transactions ⇒ same state hash" be a unit test rather than an integration test?

## Predictions (made before writing code)

Pool: 1,000 ETH / 1,000,000 USDC, fee 30 bps.

| Trade | Predicted out | Predicted slippage | Measured out | Measured slippage |
|---|---|---|---|---|
| sell 1 ETH | 996 | 40 bps | 996 | 39 bps |
| sell 10 ETH | 9,872 | 128 bps | 9,871 | 128 bps |
| sell 100 ETH | 90,661 | 934 bps | 90,661 | 933 bps |
| sell 10 ETH right after someone sold 100 | ≈ 8,700 | | 8,167 | 1,726 bps worse than alone |

## Results

- Prediction table: integer parts matched to the unit; the 1 bps gaps are floor rounding (39.93 → 39).
- Sandwich, all three in one block (bot sells 100 → victim sells 10 → bot buys back with all its USDC):

| | Alone | Sandwiched |
|---|---|---|
| Victim receives | 9,871 USDC | 8,167 USDC |
| Bot P&L | | +1.186 ETH |

- Same input twice ⇒ same hash. Swapping two transactions ⇒ different hash *and* different pool reserves,
  because fee and floor are applied per leg, so the path matters, not just the set.
- Hypothesis found two bugs before any scenario test did: a 1-unit BUY yields 0 base and divided by zero
  in `effective_price`; and `apply_swap` rebuilt `MarketState` by hand and dropped `base_asset`, which the
  "no asset is created or destroyed" property caught.

## Follow-up: the cost of immutable state

Experiment: [experiments/week-02-immutable-state](../../experiments/week-02-immutable-state/README.md).
Prediction: µs per transaction grows linearly with the number of accounts, because every executed
transaction copies the `balances` dict.

| accounts | µs/tx | tx/s |
|---|---|---|
| 100 | 17 | 58,000 |
| 1,000 | 42 | 24,000 |
| 10,000 | 1,200 | 830 |

Not linear: 10× accounts cost 2.4×, then 29×. Copying a 20,000-entry dict of dataclass values costs ≈ 600 µs,
but the same dict with `int` values costs 86 µs. The copy has to touch every value object to bump its refcount,
and 20,000 scattered objects no longer fit the core's L2 cache (512 KiB). Two balance copies per transaction
account for the whole 1,200 µs.

At 10,000 accounts the pure-copy design already misses the 5,000 tx/s target by 6×. Decision deferred to week 3
(ADR): copy once per block and mutate inside with explicit revert, or a persistent map.

## What I learned

1. The average price of a trade is not the price after it. Selling 100 ETH at "906 each" leaves the pool at
   827, and the next seller trades against 827. I predicted the sandwiched fill from the average and got
   8,700; the answer was 8,167. Price impact is ≈ Δx / (x + Δx): near-linear for small trades, so 10× the
   size is ≈ 10× the impact, but it bends down as Δx approaches x (10 → 98 → 904 bps).
2. Order is state. Same three transactions, two orders, different pool reserves and a different hash, because
   fee and floor are applied on every leg. "Same snapshot + same transactions" is not enough for replay;
   it needs the same *sequence*. That is what the block builder decides in week 3, and why the sandwich exists.
3. Property tests find bugs that worked examples cannot. Hypothesis found a division by zero on a 1-unit
   swap and a dropped `base_asset` field, both in cases I would never have typed by hand. The invariants worth
   writing are the ones a human can state in a sentence: k never decreases, no asset is created or destroyed.
4. Integer-only arithmetic has an edge to design for. Floor rounding in the pool's favour makes the reported
   slippage 39 bps where the exact value is 39.93, and a 1-unit BUY returns 0 base. Both are decisions
   (ADR-0007), not accidents.
5. Immutability has a price and the price is not linear. Copying a dict per transaction costs O(entries), but
   the constant jumps ~14× when the values are objects that no longer fit in L2: a copy must touch every value
   to bump its refcount. Week 1 was about queues; this week the bottleneck was the memory hierarchy.
   Measure before trusting a "linear" intuition, and read the *per-entry* cost, not just the total.
6. A nonce rule has to survive a wrong nonce. If BAD_NONCE consumed a nonce, one mis-numbered submission would
   strand every correctly numbered transaction behind it. The other failures (balance, slippage) consume it so
   a retry needs a new number and cannot execute twice.

## Questions carried to next week

- The block builder (week 3) decides the order. Which policy makes the sandwich impossible, and what does it cost
  honest users in latency?
- `execute_block` is O(n) pure Python; at 5,000 tx/s where does its time go, and does it ever share an event loop
  with the WebSocket fan-out? (carried from week 1)

## References

- Spec §5 (constant-product AMM, slippage limit), §9, §11, §12
- Uniswap v2 core: `getAmountOut`, fee on input, `INSUFFICIENT_OUTPUT_AMOUNT`
