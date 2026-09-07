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
| Follow-up run | `POOL_SIZE=128`, default stages, to test finding 5 (does a bigger pool reach the loop's ≈ 4000?) |
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

# terminal 1 — server, pinned to cores 0-3 (one POOL_SIZE per run; set N in both terminals)
N=4; POOL_SIZE=$N SERVICE_MS=20 taskset -c 0-3 uv run python experiments/week-01-performance/server.py

# terminal 2 — load, pinned to cores 4-11; the full summary breaks every metric down per stage
N=4; taskset -c 4-11 k6 run --summary-mode=full -e POOL_SIZE=$N -e SERVICE_MS=20 \
  experiments/week-01-performance/load-test.js 2>&1 | tee experiments/week-01-performance/results/pool-$N.txt

# terminal 3 — sample the server's queue once a second (in_flight / waiting / served per second)
uv run python experiments/week-01-performance/stats_sampler.py | tee experiments/week-01-performance/results/pool-$N-stats.txt
```

Control run: same, with the pool effectively unbounded and stages relative to the row-64 guess.

```bash
POOL_SIZE=100000 SERVICE_MS=20 taskset -c 0-3 uv run python experiments/week-01-performance/server.py
taskset -c 4-11 k6 run --summary-mode=full -e POOL_SIZE=100000 -e SERVICE_MS=20 -e CAPACITY=2500 \
  experiments/week-01-performance/load-test.js 2>&1 | tee experiments/week-01-performance/results/pool-100000.txt
```

Reading the summary, per stage: `http_req_duration` p(50)/p(95)/p(99) from the line **without** `expected_response:true`
(so timeouts count), `http_reqs` rate as the measured C, `http_req_failed`, and `dropped_iterations`.
A stage with `dropped_iterations > 0` is invalid: the server saw less load than the stage's label says.
k6 prints `dropped_iterations` only when it is non-zero, so no line means 0.

Two traps when reading per-stage numbers:

- The per-scenario `http_reqs` rate is the count divided by the **whole run's** duration, not the stage's 20 s.
  It is also the number of requests *sent*, which in an open model equals the arrival rate, not the server's throughput.
- The server's real capacity is therefore derived, not read. In an overloaded stage the failures start at the moment
  the wait first exceeds the timeout, so with failed fraction `f`, onset `t* = 20 s × (1 − f)`, and
  `C_measured = λ · t* / (t* + timeout)`. Two overloaded stages should give the same C; if they do not, something
  besides the pool is going on.
Raw output lives in `results/` (git-ignored). Copy the numbers into the table below.

## Results

Latencies in ms, from the `http_req_duration` line that includes timeouts. `t*` is when failures began:
`successful requests ÷ λ`. That equals `20 s × (1 − failed)` when nothing was dropped and stays right when
drops shrink the request count. The derived-capacity table below is computed from it.

### Per stage

| `POOL_SIZE` | stage | λ (req/s) | p50 | p95 | p99 | failed | dropped | notes |
|---|---|---|---|---|---|---|---|---|
| 1 | 0.5·C | 25 | 21.8 | 22.5 | 23.0 | 0 % | 0 | |
| 1 | 0.9·C | 45 | 21.5 | 22.1 | 22.5 | 0 % | 0 | |
| 1 | 1.1·C | 55 | 1448 | 2001 | 2001 | 32.9 % | 0 | t* ≈ 13.4 s |
| 1 | 1.5·C | 75 | 2000 | 2001 | 2001 | 82.5 % | 0 | t* ≈ 3.5 s |
| 4 | 0.5·C | 100 | 21.1 | 22.1 | 23.0 | 0 % | 0 | |
| 4 | 0.9·C | 180 | 21.2 | 22.1 | 29.8 | 0 % | 0 | |
| 4 | 1.1·C | 220 | 1370 | 2001 | 2001 | 37.2 % | 0 | t* ≈ 12.6 s |
| 4 | 1.5·C | 300 | 2000 | 2001 | 2001 | 83.2 % | 0 | t* ≈ 3.4 s |
| 16 | 0.5·C | 400 | 20.8 | 21.8 | 35.4 | 0 % | 0 | |
| 16 | 0.9·C | 720 | 20.8 | 32.4 | 58.6 | 0 % | 0 | p95/p99 rising below capacity |
| 16 | 1.1·C | 880 | 1763 | 2001 | 2001 | 56.6 % | 0 | t* ≈ 8.7 s; busy VUs plateau at 1761 = 880 × 2 s |
| 16 | 1.5·C | 1200 | 2000 | 2001 | 2001 | 84.5 % | 3281 | **invalid** from ~5 s (VU cap); t* ≈ 2.7 s from the pre-drop part |
| 64 | 0.5·C | 1600 | 21.0 | 59.6 | 118 | 0 % | 0 | tails already fat below the pool's capacity: the loop is the bottleneck |
| 64 | 0.9·C | 2880 | 919 | 1104 | 1237 | 0 % | 14775 | **invalid**: VUs capped at 2000 → closed model; server took 2141/s |
| 64 | 1.1·C | 3520 | 883 | 1072 | 1502 | 0 % | 25934 | invalid; server took 2224/s |
| 64 | 1.5·C | 4800 | 852 | 1023 | 1418 | 0 % | 49370 | invalid; server took 2332/s. 0 % failed is an artifact: W = 2000 VUs ÷ throughput ≈ 0.9 s < timeout |
| 128 (follow-up) | 0.5·C | 3200 | 349 | 2000 | 2001 | 15.7 % | 5453 | offered rate already above the effective capacity; a backlog forms at stage start and the loop congests |
| 128 (follow-up) | 0.9·C | 5760 | 438 | 1978 | 2000 | 14.3 % | 54945 | invalid (VU cap); server took 3012/s |
| 128 (follow-up) | 1.1·C | 7040 | 670 | 854 | 894 | 0.27 % | 83419 | invalid; server took 2869/s |
| 128 (follow-up) | 1.5·C | 9600 | 618 | 2000 | 2000 | 5.8 % | 134627 | invalid; server took 2869/s |
| 100000 (control) | 0.5·C | 1250 | 20.9 | 22.4 | 80.5 | 0 % | 0 | first attempt omitted `-e CAPACITY` (5 M req/s schedule, 120 M drops); this is the rerun |
| 100000 (control) | 0.9·C | 2250 | 21.1 | 41.8 | 88.5 | 0 % | 0 | |
| 100000 (control) | 1.1·C | 2750 | 21.5 | 68.4 | 117 | 0 % | 0 | no overload at all: the 2500 guess was too low |
| 100000 (control) | 1.5·C | 3750 | 46.6 | 150 | 506 | 0.38 % | 0 | loop near saturation but still keeping up |

### Derived capacity

`C_measured = λ · t* / (t* + 2 s)`, once from each overloaded stage. Effective service time is `N / C_measured`.

When a stage hits the VU cap **without** failures, k6 has degenerated into a closed model with 2000 VUs: the queue is
bounded, latency settles at `2000 ÷ throughput`, and nothing times out. `t*` does not exist then; the server's capacity is
simply requests taken ÷ 20 s. Pool 64 is that case.

| `POOL_SIZE` | predicted C | C from 1.1·C | C from 1.5·C | measured / predicted | effective S (ms) |
|---|---|---|---|---|---|
| 1 | 50 | 47.9 | 47.8 | 0.96 | 20.9 |
| 4 | 200 | 189.8 | 188.1 | 0.95 | 21.2 |
| 16 | 800 | 715 | 687 (pre-drop) | 0.88 | 22.8 |
| 64 | 3200 | n/a (no failures) | 2140–2330 (requests taken ÷ 20 s in VU-capped stages) | 0.69 | 29 (includes loop hand-off, not just sleep) |
| 128 (follow-up) | 6400 | n/a (VU-capped) | 2870–3010 | 0.46 | 44 = 20 sleep + ≈ 24 hand-off |
| 100000 (control) | 2500 (guess) | n/a | > 3750 (never overloaded; ≈ 4000 by the p99 trend) | ≥ 1.5 × the guess | per-request loop cost ≈ 0.25 ms |

### Observed with `/stats` (1 s samples from `stats_sampler.py`)

| run | stage | in_flight | waiting | served/s |
|---|---|---|---|---|
| control (unbounded pool) | all four | 25–430 | 0 | equal to the arrival rate at every stage, including 3750 |
| 64 | 0.5·C | ≈ 32 | 0, brief blips to 15–50 | 1600 |
| 64 | 0.9·C, 1.1·C, 1.5·C | 64, pinned | 1870–1936 | 1900–2400, mean ≈ 2200 |
| 128 | all capped stages | 128, pinned | 1540–1870 | 2560–3070, mean ≈ 2800; the sampler's own request timed out (5 s) at stage starts |

The pool-64 rerun reproduced the first run (2169 / 2187 / 2330 requests taken per second in the three capped stages).

## Findings

1. **Little's law predicted the knee within 5 % for pools 1 and 4**, and the wait growth (0.5·t at 1.5·C) exactly.
   The 5 % was a service time of ≈ 21 ms instead of 20: `asyncio.sleep` wakes on the next loop iteration, not on time.
2. **Near capacity, small errors explode.** At 1.1·C a 4 % lower capacity made the queue grow 50 % faster, so failures
   began at 13 s instead of 20 s. At 1.5·C the same error was invisible. Running at 90 % utilisation is fragile for this reason.
3. **The event loop costs something well below its own ceiling.** At pool 16 the measured/predicted ratio fell to 0.88 and
   p99 at 0.9·C rose to 59 ms; the hypothesis expected the loop to matter only at 64.
4. **The loop's raw capacity is ≈ 4000 req/s**, not the 2500 guessed: the control run took 3750 req/s at p50 47 ms with
   0.38 % timeouts and `waiting` = 0 throughout.
5. **Pool 64 still stopped at ≈ 2200 req/s with the pool full**: `in_flight` = 64 and ≈ 1900 waiting on it. The slot cycle was
   64 / 2200 = 29 ms: 20 ms of sleep plus ≈ 9 ms of loop hand-off (release → wake the next waiter → next iteration), and the
   hand-off grows with the backlog. The bottleneck is coupled: the pool is full *because* the loop delays its turnover.
   **Tested with pool 128: it reached ≈ 2900, not 4000.** The hand-off wait grew from ≈ 9 ms to ≈ 24 ms because each
   iteration had more to do under the same 2000-connection backlog. A bigger pool has diminishing returns; the fix is
   bounding the backlog so iterations stay short, which is week 3.
6. **An open-model test silently becomes closed when the VU cap binds without failures.** Latency settled at
   2000 ÷ throughput ≈ 0.9 s, under the timeout, so a server at 100 % reported 0 % errors. Coordinated omission, observed.
7. **Generator bookkeeping matters as much as the server.** One control run was invalid because one env var was missing;
   `load-test.js` now refuses implausible capacities, and per-stage `dropped_iterations` is the first thing to read.

## Write-up

- Did the knee land where Little's law said? If not, where did the time go: event loop, k6, TCP accept, Python overhead?
- Learning note: [docs/learning/week-01-performance.md](../../docs/learning/week-01-performance.md)
