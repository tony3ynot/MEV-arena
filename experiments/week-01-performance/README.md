# week-01-performance

One-off learning experiment. Promote to `benchmarks/` only once it proves worth re-running.

## Question

When a server's work is gated by a fixed-size pool (a DB connection pool, a thread pool, a rate-limited
upstream), how do throughput and tail latency behave as load approaches and then passes the pool's capacity?
Can the knee be predicted before it is measured?

## Hypothesis

Little's law (`L = λ · W`) predicts the knee. With service time `S` and pool size `N`, capacity is `C = N / S`.

- `λ < C`: latency stays near `S`, throughput equals `λ`, nothing waits.
- `λ > C`: throughput caps at `C`; the queue grows by `(λ − C)` requests per second; latency grows with time,
  so the p99 you see depends on how long the overload is held.
- For large `N`, the pool stops being the bottleneck and the single-threaded event loop takes over, so the
  measured knee lands below the predicted one.

## Setup

- `server.py` — FastAPI on uvicorn, one worker, uvloop, access log off.
  `GET /query` acquires a slot from `asyncio.Semaphore(POOL_SIZE)`, then `await asyncio.sleep(SERVICE_MS / 1000)`
  stands in for a DB round-trip of fixed duration. `GET /stats` reports in-flight and waiting counts so queueing
  is visible while a test runs.
- `load-test.js` — k6 **open-model** load (`ramping-arrival-rate`). The test fixes the arrival rate; the server's
  slowness does not slow the generator down. A closed model (fixed VUs) would self-throttle and hide the
  saturation (the coordinated-omission trap).
- The pool **waits, never rejects**. Bounded queues and fail-fast are week 3 (backpressure).
- Stages run back to back in one k6 run with a 10 s cooldown between them. Without the cooldown the 1.1·C
  stage would hand its leftover queue to the 1.5·C stage and the "after N seconds" predictions would not apply.
- One machine for both sides: the server is pinned to cores 0–3 and k6 to cores 4–11 with `taskset`, so neither
  starves the other. Both pins are recorded with the results.
- If k6 reports `dropped_iterations > 0` for a stage, the generator ran out of VUs and the numbers for that stage
  are invalid. Record it rather than raising `maxVUs` blindly.

## Parameters

| Knob | Values |
|---|---|
| `SERVICE_MS` | 20 |
| `POOL_SIZE` | 1, 4, 16, 64 (one run each) |
| Control run | `POOL_SIZE=100000` so the pool never binds: the measured C is the event-loop capacity. Stages are relative to the guess `-e CAPACITY=2500` instead of N / S |
| Arrival rate stages | 0.5·C, 0.9·C, 1.1·C, 1.5·C, held 20 s each; C computed from the two knobs above |
| Cooldown | 10 s at zero arrival rate after every stage, so each stage starts from an empty queue |
| k6 request timeout | 2 s |
| k6 `maxVUs` | 2000 |

## Prediction — fill in BEFORE running

| `POOL_SIZE` | predicted C (req/s) | predicted p99 at 0.5·C | predicted p99 at 0.9·C | what happens at 1.5·C after 20 s |
|---|---|---|---|---|
| 1 | 50 | 20 | 20 | p99 max 2s req fail from 4s, necessary VU = 150 |
| 4 | 200 | 20 | 20 | p99 max 2s req fail from 4s, necessary VU = 600 |
| 16 | 800 | 20 | 20 | p99 max 2s req fail from 4s, necessary VU = 2400 -> dropped iteration |
| 64 | 3200 | 20 | > 20 | p99 max 2s req fail from 4s, necessary VU = 9600 -> dropped iteration, estimated loop size 2500 -> 0.8·C p99 > 20 |
| 100000 (control) | 2500 = event-loop capacity guess; the pool never binds | 20 | 20 | knee lands between the 0.9·C and 1.1·C stages of the guess; VUs 3750 × 2 = 7500 → 1.5·C invalid |

## How to run

Each run takes about 2 minutes: 4 stages × (20 s + 10 s cooldown). One run per `POOL_SIZE`.

```bash
mkdir -p experiments/week-01-performance/results

# terminal 1 — server, pinned to cores 0-3 (one POOL_SIZE per run)
POOL_SIZE=4 SERVICE_MS=20 taskset -c 0-3 uv run python experiments/week-01-performance/server.py

# terminal 2 — load, pinned to cores 4-11; the full summary breaks every metric down per stage
taskset -c 4-11 k6 run --summary-mode=full -e POOL_SIZE=4 -e SERVICE_MS=20 \
  experiments/week-01-performance/load-test.js | tee experiments/week-01-performance/results/pool-4.txt

# terminal 3 (optional) — watch the server's queue while a stage runs
watch -n 1 curl -s localhost:8000/stats
```

Control run: same, with the pool effectively unbounded and stages relative to the row-64 guess.

```bash
POOL_SIZE=100000 SERVICE_MS=20 taskset -c 0-3 uv run python experiments/week-01-performance/server.py
taskset -c 4-11 k6 run --summary-mode=full -e POOL_SIZE=100000 -e SERVICE_MS=20 -e CAPACITY=2500 \
  experiments/week-01-performance/load-test.js | tee experiments/week-01-performance/results/pool-100000.txt
```

Reading the summary, per stage: `http_req_duration` p(50)/p(95)/p(99) from the line **without** `expected_response:true`
(so timeouts count), `http_reqs` rate as the measured C, `http_req_failed`, and `dropped_iterations`.
A stage with `dropped_iterations > 0` is invalid: the server saw less load than the stage's label says.
k6 prints `dropped_iterations` only when it is non-zero, so no line means 0.
Raw output lives in `results/` (git-ignored). Copy the numbers into the table below.

## Results

| `POOL_SIZE` | measured C (req/s) | p50 | p95 | p99 | errors / timeouts | dropped iterations | notes |
|---|---|---|---|---|---|---|---|
| 1 | | | | | | | |
| 4 | | | | | | | |
| 16 | | | | | | | |
| 64 | | | | | | | |
| 100000 (control) | | | | | | | |

## Write-up

- Did the knee land where Little's law said? If not, where did the time go: event loop, k6, TCP accept, Python overhead?
- Learning note: [docs/learning/week-01-performance.md](../../docs/learning/week-01-performance.md)
