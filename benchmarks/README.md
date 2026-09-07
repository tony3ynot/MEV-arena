# Benchmarks

Only tests that are re-run to catch **performance regressions** live here. One-off exploration goes in `experiments/`.

## Measurement environment (spec §14 requires this to be recorded)

| Item | Value |
|---|---|
| CPU | AMD Ryzen 5 PRO 4650G, 6C/12T |
| RAM | ~7 GB visible to WSL2 (adjustable in `.wslconfig`) |
| Disk | SSD, ext4 on a WSL2 virtual disk |
| OS | Linux 6.6.87.2, WSL2 on Windows |
| Python | 3.12 |
| uv | 0.12.6 |
| Docker | 28.3.3 |
| k6 | not installed yet; record before week 7 |

> The load generator, the server under test, and Redpanda/PostgreSQL/Redis all run on the **same machine**.
> Numbers matter as before/after comparisons, not as absolutes.

## SLO targets (spec §14)

| Metric | Target |
|---|---|
| concurrent bots | 10,000 |
| tx submissions / s | 5,000 |
| websocket clients | 1,000 |
| submission p99 | 200 ms |
| error rate | 0.1 % |
| duplicate execution | 0 |
| deterministic replay | true |
| recovery time | 30 s |

Missing a target is not failure. The completion criterion is publishing the saturation point, its cause,
the change made, and before/after measurements.

## Running

```bash
# TODO (week 7): k6 run benchmarks/simulate-load.js
```
