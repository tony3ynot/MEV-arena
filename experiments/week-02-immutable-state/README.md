# week-02-immutable-state

One-off learning experiment. Promote to `benchmarks/` only once it proves worth re-running.

## Hypothesis

`execute_transaction` copies the whole `balances` dict (twice) and the `nonces` dict on every executed
transaction. Prediction before running: **cost per transaction grows linearly with the number of accounts.**

## How to run

```bash
taskset -c 2 uv run python experiments/week-02-immutable-state/bench.py
```

2,000 transactions per block, best of 3 runs, one pinned core (Ryzen 5 PRO 4650G: L2 512 KiB per core, L3 4 MiB shared).

## Results

| accounts | balance entries | tx/s | µs/tx | ×  vs previous row |
|---|---|---|---|---|
| 100 | 200 | 58,344 | 17.1 | |
| 1,000 | 2,000 | 23,897 | 41.8 | 2.4× |
| 10,000 | 20,000 | 833 | 1,200 | **29×** |

The first, un-warmed run gave 530 tx/s at 10k accounts; with `gc.disable()` 877. GC and first-touch allocation
are factors at 10k, not the cause.

Where the 10k-account cost comes from (single `{**d, k: v}` of a 20,000-entry dict, 50 reps, µs):

| dict | µs per copy |
|---|---|
| tuple keys, `AccountBalance` values | 601 |
| tuple keys, `int` values | 86 |
| str keys, `int` values | 81 |
| int keys, `int` values | 63 |

Two copies of the balances dict per transaction ≈ 2 × 582 ≈ 1,160 µs, which is the measured 1,140 µs/tx with GC off.
The accounting closes.

Per-entry cost of the copy is not constant either: 8 ns at 200 entries, 16 ns at 2,000, ≈ 225 ns at 20,000.

## Write-up

- Learning note: [docs/learning/week-02-execution.md](../../docs/learning/week-02-execution.md)
