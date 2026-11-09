# week-04-ordering-policies

One-off learning experiment. Promote to `benchmarks/` only once it proves worth re-running.

## Question

With the same bots and the same seeds, how much does the builder policy alone change what the sandwich bot earns
and what its victims pay? (Spec §4 steps 7–8, §19 "results of the three builder policies can be compared".)

## Hypothesis

Predictions were written before any code: see the table in
[docs/learning/week-04-bots.md](../../docs/learning/week-04-bots.md#predictions-made-before-writing-code).

The ones this experiment answers:

- FIFO: no sandwich ever lands, because the bot only sees a victim after it arrived.
- PRIORITY_FEE: sandwiches land, since the front-run outbids the victim.
- RANDOM: about a third land.
- Doubling the victims' tolerance at most doubles the bot's profit.
- About 40 % of noise swaps are worth sandwiching (log 10 / log 300: sizes above fee × reserve = 3 ETH).
- Alone, the arbitrage bot trades in about 0.3 % of blocks.

## Setup

- `run.py` drives the pure arena, `simulation_engine.arena.run_block`, block by block. No server, no clock: the same
  arguments print the same tables on any machine.
- Pool: 1,000 ETH / 1,000,000 USDC, fee 30 bps. Block capacity 10.
- Bots, in the order they act each block:
  - 20 `NoiseTrader` (activity 0.3, sizes log-uniform 0.1–30 ETH, tolerance 1 %, fee 0–100)
  - 1 `ArbitrageBot`
  - 1 `SandwichBot`, acting last so it sees the block's flow
- Start balances: noise 100 ETH + 100,000 USDC each, sandwich the same, arbitrage ten times that.
- Reference price: uniform whole-bps step within ±10 bps per block.
- Priority fees are bids only; execution does not charge them yet (ADR-0012 pending).
- Policies: FIFO, PRIORITY_FEE, RANDOM. ADVERSARIAL waits for ADR-0012.

## How to run

```bash
uv run python experiments/week-04-ordering-policies/run.py              # 20 seeds × 200 blocks, about 5 min
uv run python experiments/week-04-ordering-policies/run.py --seeds 2 --blocks 50   # smoke run, seconds
```

## What is measured

- **Sandwich attempt outcome**, judged within the block it was sent in:
  - wrapped: front-run → victim → back-run, victim executed
  - victim first: the victim came before the front-run
  - back before victim: the back-run came before the victim
  - victim reverted: the order was right, but the victim failed on slippage
  - incomplete: one of the three missed that block
- The bot does not report its victim. The harness recovers it from the front-run: same side, the victim's fee + 1,
  same expiry, and sized by `max_front_run` for that transaction.
- **P&L**: holdings at the end minus holdings at the start, valued at the final reference price, in USDC. The
  table gives mean ± standard deviation over seeds.
- **Victim cost**: for a wrapped victim, how much less it got than it would have on the state just before the
  front-run (the block replayed up to that point), in bps. The receipt's `slippage_bps` cannot show this: it is
  measured against the price at execution, which the front-run had already moved. A first full run reported that
  field for victims and got ≈ 200 bps whatever the tolerance; it was the victims' own size, not the sandwich.
- **Other noise slippage**: receipt `slippage_bps` of every executed noise swap that was not wrapped.
- **Worth sandwiching**: an accepted noise swap the sandwich bot would attack if it were the only one pending,
  judged on the state it was sent into. A swap that waits can become worth it later, if the price moves its way.
- **Arbitrage alone**: a separate run with no other bots; the share of blocks in which the arbitrage bot's order
  executes.

## Setup sensitivity

A smoke run showed 25–30 % of noise swaps failing on slippage under every policy, so before the full run the pool
depth was varied (3 seeds × 50 blocks each; `POOL_ETH` and `NOISE_SIZE` at the top of `run.py`):

| pool, noise sizes | noise failed (priority_fee / fifo / random) | worth sandwiching | sandwich P&L, share of pool value |
|---|---|---|---|
| 1,000 ETH, 0.1–30 ETH (kept) | 26 % / 26 % / 31 % | 42 % | 0.199 % |
| 10,000 ETH, 1–300 ETH (both × 10) | 26 % / 26 % / 31 % | 42 % | 0.199 % |
| 10,000 ETH, 0.1–100 ETH | 13 % / 14 % / 20 % | 19 % | 0.010 % |
| 10,000 ETH, 0.1–30 ETH (pool only) | 1 % / 1 % / 1 % | 0 % | −0.001 % |

Scaling the pool and the trades together changes nothing, to the last digit: a constant-product pool only sees the
ratio of trade size to depth. Lowering that ratio cuts failures and sandwich opportunities together, because a
sandwich pays only above fee × depth (3 ETH here, 30 ETH at 10,000). The original setup was kept: the predictions
were made for it, and it gives the most attempts to compare policies on.

## Results

`uv run python experiments/week-04-ordering-policies/run.py`, 232 s. This is the second full run; the first reported receipt slippage for victims (see *What is measured*). Every other number is identical between the two, as it should be with one seed per run.

#### Policies (20 seeds × 200 blocks, capacity 10)

| policy | attempts | wrapped | victim first | back before victim | victim reverted | incomplete | sandwich P&L, USDC | arb P&L, USDC | victim cost mean / p95, bps | other noise slippage mean, bps | noise failed |
|---|---|---|---|---|---|---|---|---|---|---|---|
| fifo | 3212 | 0% | 78% | 0% | 0% | 22% | -5,389.86 ± 391.63 | 29,187.52 ± 5,724.71 | – / – | 81.1 | 25.5% |
| priority_fee | 3678 | 55% | 0% | 0% | 40% | 6% | 15,785.10 ± 2,411.18 | 15,435.27 ± 2,967.62 | 116.5 / 227.55 | 64.9 | 24.7% |
| random | 3654 | 11% | 45% | 30% | 4% | 10% | -5,889.91 ± 1,859.35 | 31,777.09 ± 6,027.86 | 76.8 / 270.0 | 79.4 | 28.6% |

#### Victim tolerance under priority_fee (20 seeds × 200 blocks)

| noise tolerance | sandwich P&L, USDC | × vs first row |
|---|---|---|
| 0.5 % | 10,375.22 ± 2,159.34 | 1.00 |
| 1.0 % | 15,785.10 ± 2,411.18 | 1.52 |
| 2.0 % | 27,410.00 ± 3,649.75 | 2.64 |

#### Noise swaps worth sandwiching (20 seeds × 200 blocks)

9554 of 23570 accepted noise swaps = **40.5%**

#### Arbitrage bot alone, reference ±10 bps per block (20 seeds × 1000)

traded in 2424 of 20000 blocks = **12.1%** (per seed 8.2%–15.5%)

## Interpretation

**FIFO** held exactly: 0 of 3,212 attempts wrapped. The bot does not know the policy, keeps trying, and loses
5,390 USDC to pool fees on front-run and back-run pairs that never surround anyone.

**PRIORITY_FEE** got the order right every time it could (0 % victim first, 0 % back first), yet only 55 % of
attempts wrapped a victim that executed. 40 % reverted. The front-run is sized on the block-start state to the
exact limit, so any same-side trade that pays more and executes earlier pushes the victim past its
`min_amount_out`. A reverted attempt cost the bot 30–62 USDC on average (diagnostic run, 5 seeds), a wrapped one
earned 130–320.

**RANDOM** landed 15 % (11 % wrapped, 4 % reverted), not a third. Among attempts complete in one block: 17 %
front → victim → back, 50 % victim first, 33 % back first, which is 1/6, 1/2, 1/3. The builder ranks every
transaction independently and the back-run only competes once the front-run is in, so the victim must draw
between the two: P(a < c < b) = 1/6. A third is what a uniform pick among valid orders would give, and it is
exactly the share that went front → back → victim.

**Victim cost.** Wrapped victims lost 117 bps on average under priority fees, more than their 1 % tolerance. Their
limit was set when they were sent; a victim that waited while the price moved its way carried extra slack, and
the front-run, sized to the limit on the current state, took it as well. Victims whose price moved against them
could not fill even alone and were never attacked. Under RANDOM the mean is lower (77 bps) and the tail longer:
an opposite-side trade landing between front-run and victim gives some of it back, a same-side one reverts the
victim and drops it from the sample.

**Tolerance.** × 1.52 for twice the tolerance and × 2.64 for four times. Per attempt, profit ≈ (tolerance + slack
gained while waiting) × (size − fee × reserve); the second term in the bracket does not grow with the tolerance.

**Worth sandwiching**: 40.5 % against the predicted 40.4 %.

**Arbitrage alone**: 12.1 % of blocks, not 0.3 %. The reference moves about 6 bps per block (standard deviation of a
uniform step in ±10 bps), which covers the 30 bps band in roughly 25 blocks. After a trade the pool sits on the
band edge, so the next step in the same direction, about half the time, triggers another trade.

**Arbitrage P&L** halves under priority fees: 15k against 29–32k USDC. A wrapping back-run moves the price back
toward where the victim found it, which is the move the arbitrage bot would otherwise have been paid for. Not
measured yet; carried to week 5.

Noise swaps fail 25–29 % under every policy. That is the shallow pool (setup sensitivity above), not the policy.

## Write-up

- Learning note: [docs/learning/week-04-bots.md](../../docs/learning/week-04-bots.md)
