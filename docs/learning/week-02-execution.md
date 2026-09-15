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

## What I learned

<!-- fill in: your own words, 3–5 numbered points. Prompts:
  1. Why was the sandwiched fill 8,167 and not ~8,700? (average price of a trade vs the spot price after it)
  2. Price impact ≈ Δx / (x + Δx): why 10× the size gives ~10× the impact for small trades and less for large ones
  3. What a property test caught that a worked example would not have
  4. Why BAD_NONCE is the one failure that must not consume a nonce
-->

## Questions carried to next week

- The block builder (week 3) decides the order. Which policy makes the sandwich impossible, and what does it cost
  honest users in latency?
- `execute_block` is O(n) pure Python; at 5,000 tx/s where does its time go, and does it ever share an event loop
  with the WebSocket fan-out? (carried from week 1)

## References

- Spec §5 (constant-product AMM, slippage limit), §9, §11, §12
- Uniswap v2 core: `getAmountOut`, fee on input, `INSUFFICIENT_OUTPUT_AMOUNT`
