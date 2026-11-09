# Week 04 — Bots and builder policies

> Learning notes. Code: `packages/simulation-engine` (`bots`, `block_builder`); runtime in `apps/api`; UI in `apps/web`.

## Question for the week

- With the same bots and the same seed, how much do sandwich-bot P&L and victim slippage change when only the
  builder policy changes (spec §4 steps 7–8, §19 "compare the three builder policies")?
- What exactly does a bot observe, and what has to be fixed so that a run with bots replays to the same state hash?

## Predictions (made before writing code)

Sandwich = bot front-run (nonce n) → victim → bot back-run (nonce n+1). The largest front-run is bounded by the
victim's `min_amount_out`.

| Question | Predicted | Actual |
|---|---|---|
| Only front, victim, back in the pool. Sandwich success rate under FIFO | 0: the bot sees the victim only after it arrived, so it cannot get in front | |
| … under PRIORITY_FEE | succeeds if the front-run pays a higher fee than the victim | |
| … under RANDOM | only when the front-run comes first; rate not given | |
| Victim tolerance 0.5 % → 1 %: bot profit × ? | at most × 2 | |
| Is the largest front-run the victim's `min_amount_out` allows also the most profitable? | no | |
| Bot sized its front-run on the block-start state; a noise sell lands between front-run and victim | victim loses more, bot earns more | |
| Noise sizes log-uniform in 0.1–30 ETH; a sandwich pays only above fee × reserve = 3 ETH. Share of noise swaps worth sandwiching | log 10 / log 300 ≈ 40 % | |
| Reference price moves uniformly within ±10 bps per block, no-arbitrage band ±30 bps, no noise traders. Share of blocks in which the arbitrage bot trades | 0.3 % | |

## Results

## What I learned

## Questions carried to next week

- Arbitrage that back-runs large pending swaps instead of reading only the committed state. It competes with the
  sandwich back-run for the same slot and wants bundles, so it waits for ADR-0012; week 8 extra or v0.2.

## References

- Spec §4, §5 Bots, §8 Block Builder, §18 week 4
- [ADR-0008](../decisions/0008-gateway-assigns-transaction-ids.md) (ids), [ADR-0011](../decisions/0011-builder-nonce-queues.md) (nonce queues)
