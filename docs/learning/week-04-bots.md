# Week 04 — Bots and builder policies

> Learning notes. Code: `packages/simulation-engine` (`bots`, `arena`); experiment and raw tables:
> [experiments/week-04-ordering-policies](../../experiments/week-04-ordering-policies/README.md). UI in `apps/web`,
> still on its in-browser mock. No new ADR this week; ADR-0012 (priority fees, adversarial ordering) is next.

## Question for the week

- With the same bots and the same seed, how much do sandwich-bot P&L and victim slippage change when only the
  builder policy changes (spec §4 steps 7–8, §19 "compare the three builder policies")?
- What exactly does a bot observe, and what has to be fixed so that a run with bots replays to the same state hash?

## Predictions (made before writing code)

Sandwich = bot front-run (nonce n) → victim → bot back-run (nonce n+1). The largest front-run is bounded by the
victim's `min_amount_out`.

| Question | Predicted | Actual |
|---|---|---|
| Only front, victim, back in the pool. Sandwich success rate under FIFO | 0: the bot sees the victim only after it arrived, so it cannot get in front | 0 % wrapped of 3,212 attempts: 78 % victim first, 22 % incomplete |
| … under PRIORITY_FEE | succeeds if the front-run pays a higher fee than the victim | order always right (0 % victim first or back first), yet only 55 % wrapped: 40 % victim reverted |
| … under RANDOM (later: give a number) | 33 % | 1/6. Of attempts complete in one block: 17 % front → victim → back, 50 % victim first, 33 % back before victim |
| Victim tolerance 0.5 % → 1 %: bot profit × ? | at most × 2 | × 1.52 (0.5 % → 2 %: × 2.64) |
| Is the largest front-run the victim's `min_amount_out` allows also the most profitable? | no | yes here: unconstrained, profit still grows at 600 ETH; the tolerance caps the front-run at 2.5–10 ETH. Zero only for victims below 3 ETH (computed with the engine, not in the run) |
| Bot sized its front-run on the block-start state; a noise sell lands between front-run and victim | victim loses more, bot earns more | the victim reverts, since it was sized to the boundary; the bot gains only if that sell exceeds fee × reserve. 40 % of priority-fee attempts reverted, −30 to −62 USDC each on average |
| Noise sizes log-uniform in 0.1–30 ETH; a sandwich pays only above fee × reserve = 3 ETH. Share of noise swaps worth sandwiching | log 10 / log 300 ≈ 40 % | 40.5 % |
| Reference price moves uniformly within ±10 bps per block, no-arbitrage band ±30 bps, no noise traders. Share of blocks in which the arbitrage bot trades | 0.3 % | 12.1 % (8.2–15.5 % per seed) |

## Results

### Bots and the arena step

- A bot is a pure function of a `BotView` (committed state, public mempool, reference price) and a seeded rng. It
  keeps no state and returns `Order`s without ids; ids belong to the gateway (ADR-0008).
- `max_front_run` binary-searches the largest front-run the victim's limit lets through, with `apply_swap` as the
  oracle so rounding matches the engine. Hypothesis found a 1-unit front-run that fills zero: the engine reverts
  it and leaves the price alone, `max_front_run` had applied it anyway. Pinned with `@example`.
- `SandwichBot` simulates front-run → victim → back-run on the committed state and bids the victim's fee + 1 and
  the victim's fee. A cross-side test caught comparing an ETH profit with a USDC profit as raw integers.
- `ArbitrageBot` uses the closed form `(√(x·y·γ·P) − y) / γ` via `math.isqrt`. It leaves the pool just inside the
  near band edge, not on it: the fee stays in the pool, ≈ 1.5 bps further at a 10 % gap.
- `run_block` is the one pure step for the experiment and, later, the clock. A test pins the seed strings, because
  seeds made with `hash()` pass an in-process determinism check and change between processes.
- Every test file was run against a reference implementation and 6–9 deliberate mutants. Three mutants survived
  a first draft: global `random` hidden by `activity = 1.0`, a fixed builder seed hidden by blocks that differ
  anyway, and an always-truthy assert. Those tests were rewritten.

### Policy comparison (20 seeds × 200 blocks)

| | FIFO | PRIORITY_FEE | RANDOM |
|---|---|---|---|
| sandwich wrapped / reverted | 0 % / 0 % | 55 % / 40 % | 11 % / 4 % |
| sandwich P&L, USDC | −5,390 | +15,785 | −5,890 |
| arbitrage P&L, USDC | +29,188 | +15,435 | +31,777 |
| victim cost vs. no front-run, mean / p95 | – | 117 / 228 bps | 77 / 270 bps |
| noise swaps failed | 25.5 % | 24.7 % | 28.6 % |

## What I learned

1. **"Random" ordering has two definitions, and MEV tells them apart.** Independent random ranks behind nonce
   queues give a sandwich 1/6; a uniform pick among valid orders gives 1/3. My 33 % was the second. The run
   reproduced 1/6, 1/2, 1/3 for wrapped, victim first, back first. Which "random" a policy means is a decision to
   write down, not an implementation detail.
2. **The victim's tolerance is the attacker's budget.** In this range the largest front-run the limit allows is
   also the most profitable, and profit ≈ t·(v − fee·reserve). So only swaps above fee × reserve are prey:
   log 10 / log 300 predicted 40.4 %, the run measured 40.5 %.
3. **Sized to the boundary means fragile.** Under priority fees the order was right in 95 % of attempts, yet 40 %
   reverted: any same-side trade earlier in the block pushes the victim past its limit, and the bot pays two pool
   fees for nothing. The front-run is sized on the block-start state, which is stale by the time it executes.
4. **A stale limit leaks more than the tolerance.** `min_amount_out` is fixed at submission. A victim that waited
   while the price moved its way carries extra slack, and the bot takes that too: 83 bps taken at a 0.5 %
   tolerance. Part of the profit does not scale with the tolerance, so doubling it gave × 1.52, not × 2.
5. **Measure against the right counterfactual.** Receipt slippage is relative to the price at execution, which the
   front-run had already moved, so it read ≈ 200 bps for victims whatever their tolerance: their own size, not
   the sandwich. The cost is the gap to the state just before the front-run, 117 bps. The first full run reported
   the wrong column.
6. **A constant-product pool only sees ratios.** Pool × 10 and trades × 10 gave the same numbers to the last
   digit. Lowering the trade-to-depth ratio cuts failed swaps and sandwich opportunities together, because a
   sandwich pays only above fee × depth.
7. **Copied rules drift, and passing tests are samples.** `max_front_run` re-implemented the engine's fill check and
   missed the zero-fill revert for the front-run (ADR-0010's lesson again). Hypothesis found it on one run and
   not another, so it is pinned. And three test drafts passed for the wrong reason until a mutant showed it:
   the harness needs as much care as the system (weeks 1 and 3).

Also: the arbitrage bot traded in 12 % of blocks, not 0.3 %. A walk of ≈ 6 bps per block covers 30 bps in about
25 blocks (√n), and after each trade the pool sits on the band edge, so the next step the same way, about half
the time, triggers another trade. Trades come in runs while the reference trends.

## Questions carried to next week

- Moved from week 4: the 3-second clock and bot runner on `run_block`, the gateway's read API and WebSocket, the UI
  on real engine data. Tag `v0.0.1` when the UI runs on the engine.
- ADR-0012. Charge priority fees (to a builder account? do failed transactions pay, EVM-style?) and define
  ADVERSARIAL. Bundles would also remove the 40 % reverted: no victim, no front-run.
- Arbitrage P&L halves under priority fees (15k against 29–32k USDC). Does the sandwich back-run take back price
  impact the arbitrage bot would otherwise collect? Track value flows by account.
- Should the sandwich bot leave a margin below the boundary? Fewer reverts against less extracted.
- From the UI contract: a `TransactionDropped` event for transactions that leave the pool unexecuted, and a `seq`
  on stream frames (with Kafka offsets, week 5).
- `NoiseTrader` sizes use `math.exp` / `math.log`, which may differ in the last bit across platforms. Replay across
  machines (week 6) may need integer sizes.
- Arbitrage that back-runs large pending swaps instead of reading only the committed state. It competes with the
  sandwich back-run for the same slot and wants bundles, so it waits for ADR-0012; week 8 extra or v0.2.
- Still open from week 3: O(log n) eviction, sorting the pool every block, gateway throughput. From week 2: copy
  state once per block.

## References

- Spec §4, §5 Bots, §8 Block Builder, §18 week 4, §19
- [ADR-0007](../decisions/0007-amm-and-execution-semantics.md) (failed transactions spend their nonce),
  [ADR-0008](../decisions/0008-gateway-assigns-transaction-ids.md) (ids),
  [ADR-0010](../decisions/0010-expiry-rule-and-candidate-set.md) (one rule, one place),
  [ADR-0011](../decisions/0011-builder-nonce-queues.md) (nonce queues)
- Uniswap v2 `getAmountOut` and the optimal-arbitrage closed form
- Flashbots bundles: atomic inclusion as the answer to failed sandwiches
