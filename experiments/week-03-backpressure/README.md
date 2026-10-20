# week-03-backpressure

One-off learning experiment. Promote to `benchmarks/` only once it proves worth re-running.

## Question

Producers (bots) can submit faster than blocks can include. What does bounding the mempool buy, what does it
cost, and does the bound's own policy (evict the cheapest, ADR-0009) hold up under that load?

Week 1 ended on this: a deep backlog made every event-loop iteration longer, and "the fix is bounding the backlog
so iterations stay short".

## Hypothesis

The consumer is the block producer: `BLOCK_CAP` transactions every `BLOCK_MS`, so `C = BLOCK_CAP / BLOCK_MS`.
With arrival rate `λ`:

- `λ < C`: the pool stays near empty and a transaction waits about half a block.
- `λ > C`, unbounded: the pool grows by `(λ − C)` per second, and by Little's law the wait in the pool grows with it
  (`W = L / C`). Nobody is told to slow down; everyone just waits longer.
- `λ > C`, bounded at `N`: depth stops at `N`, the wait stops at about `N / C`, and the excess `(λ − C)` is answered
  with `429` or pushes out a cheaper transaction. Low fees pay for the overload.

Not yet known: what the bound costs per submission, and whether the pool's size affects the cost of building a block.

## Setup

- `server.py`: FastAPI on uvicorn, one worker, uvloop, as in week 1. `POST /tx` runs `Mempool.add` and answers
  `202` (stored, perhaps evicting someone) or `429` (`POOL_FULL`). A background task builds a block every
  `BLOCK_MS` with the priority-fee policy and removes what it picked. Both share the one event loop.
  Every transaction comes from a fresh account with nonce 0, so nonces never hold anything back.
- `load-test.js`: k6 **open-model** load (`constant-arrival-rate`), fees uniform in [0, 100). `429` counts as an
  answer, not a failure; `http_req_failed` counts timeouts and errors only.
- `stats_sampler.py`: once a second, pool depth, accepted / full / evicted / included per second, wait in pool
  p50 / p99, slowest block build, mean fee included vs shed, server RSS.
- Pinning as in week 1: server on cores 0–3, k6 on 4–11.
- The pool is the only bound under test. Expiry is off (`expires_at` far away), and producers ignore `429`
  (open model). A producer that backs off on `429` would be true backpressure; that is a possible follow-up.

## Parameters

| Knob | Values |
|---|---|
| `BLOCK_CAP`, `BLOCK_MS` | 40 transactions every 100 ms, so C = 400 tx/s (the first attempt used 100, C = 1000; see Results) |
| `MAX_SIZE` | 0 (unbounded), 10 000, 1 000; one run each, then the 2.5·C stage repeated |
| Arrival rate stages | 0.5·C, 1.5·C, 2.5·C (200, 600, 1000 tx/s), held 30 s each |
| Cooldown | 30 s at zero load after every stage, so the pool can drain |
| k6 request timeout | 2 s |
| k6 `maxVUs` | 6000 (rate × timeout × 1.1, so the cap never binds) |

## Prediction — fill in BEFORE running

| `MAX_SIZE` | 1.5·C: depth after 30 s | 1.5·C: wait in pool at the end | 2.5·C: p99 submit latency | 2.5·C: share answered 429 |
|---|---|---|---|---|
| 0 (unbounded) | | | | |
| 10 000 | | | | |
| 1 000 | | | | |

Key prediction, recorded before running: at 2.5·C, **unbounded** has the worst submit p99 of the three.
Reason given: a pool that grows without limit makes the server's work heavier and heavier.
(Made for the C = 1000 design; the stages are the same multiples of C, so it carries over to C = 400.)

## How to run

About 3 minutes per run: 3 stages × (30 s + 30 s cooldown). One run per `MAX_SIZE`. Defaults are C = 400
on both sides. Check that port 8000 is free first: a server left over from an earlier run answers instead of yours.

```bash
mkdir -p experiments/week-03-backpressure/results

# terminal 1: server on cores 0-3
N=1000; MAX_SIZE=$N taskset -c 0-3 uv run python experiments/week-03-backpressure/server.py

# terminal 2: load on cores 4-10; add -e LEVELS=2.5 to run only the last stage
N=1000; taskset -c 4-10 k6 run --summary-mode=full -e MAX_SIZE=$N \
  experiments/week-03-backpressure/load-test.js 2>&1 | tee experiments/week-03-backpressure/results/size-$N.txt

# terminal 3: one sampler only (the server resets interval figures on each call)
N=1000; uv run python experiments/week-03-backpressure/stats_sampler.py \
  | tee experiments/week-03-backpressure/results/size-$N-stats.txt
```

Reading the k6 summary per stage: `http_req_duration` p50 / p99, the `stored 202` check rate (admission rate), and
`http_req_failed` (timeouts). A stage with `dropped_iterations` is invalid.

## Results

Machine: AMD Ryzen 5 PRO 4650G (12 threads), WSL2, k6 v2.2.0. Submit latencies in ms from `http_req_duration`,
timeouts included. "Stored" is the share answered `202`; the rest is `429` or timed out.

### Unit costs (standalone, measured to choose the parameters)

| Operation | Cost |
|---|---|
| `add` with room | 5 µs |
| `add` into a full pool (O(n) scan for the cheapest) | 0.185 ms at 1 000, **2.4 ms at 10 000** |
| One block (`expire` + `candidates` + `build_block` + removals) | 2.6 ms at depth 1 000, 30 ms at 10 000, 287 ms at 50 000 |

### Main runs, C = 400

| `MAX_SIZE` | stage | λ | p50 | p99 | stored | timed out | notes |
|---|---|---|---|---|---|---|---|
| unbounded | 0.5·C | 200 | 1.2 | 2.3 | 100 % | 0 | |
| unbounded | 1.5·C | 600 | 1.4 | 162 | 100 % | 0 | depth 6 200 at the end; block build up to 140 ms |
| unbounded | 2.5·C | 1000 | 270 | 854 | 100 % | 0 | depth 22 700 and rising; inclusion fell from 400/s to 62/s; block build 320 ms |
| 10 000 | 0.5·C | 200 | 1.3 | 2.3 | 100 % | 0 | |
| 10 000 | 1.5·C | 600 | 1.6 | 173 | 100 % | 0 | never filled (6 200 at the end) |
| 10 000 | 2.5·C | 1000 | 2.4 | 2001 | 51 % | 49 % | sampler blind from the moment the pool filled |
| 1 000 | 0.5·C | 200 | 1.2 | 2.3 | 100 % | 0 | |
| 1 000 | 1.5·C | 600 | 1.4 | **28** | 95 % | 0 | depth pinned at ≈ 1 000; ≈ 210/s shed (35 × 429, 175 evicted); fee shed 15 vs included 68 |
| 1 000 | 2.5·C | 1000 | 833 | 2001 | 23 % | 71 % | |

After the 1.5·C stage the unbounded and 10 000 pools drained ≈ 6 000 leftovers; those waited 30–44 s (p99 at drain).

### 2.5·C repeated (30 s, fresh server each run)

| condition | p99 per run | timed out per run |
|---|---|---|
| control: consumer unlimited, pool never fills | 994, 434 (and 181, 13, 174 in three earlier runs) | 0 % in all |
| unbounded | 854, 1047, 1176 | 0 %, 0 %, 0 % |
| 10 000 | 2001, 2001, 2001 | 49 %, 49 %, 50 % |
| 1 000 | 2001 × 4 | 71 %, 15 %, 34 %, 15 % |

### First attempt, C = 1000: invalid as a pool comparison

| condition | 1.5·C (1500/s) | 2.5·C (2500/s) |
|---|---|---|
| unbounded | p99 1851, 0.45 % timed out; depth 27 700; inclusion fell to ≈ 300/s; block build up to 480 ms | 67 % timed out, dropped iterations |
| 10 000 | 52 % timed out, dropped iterations | 68 % timed out |
| 1 000 | 63 % timed out with depth ≈ 900 | 80 % timed out |
| control: consumer unlimited | p99 1380, 0.02 % timed out | **37 % timed out** |

The control shows the HTTP layer alone (FastAPI + pydantic POST on one loop) is at its limit near 1500/s and
past it at 2500/s, so these runs measured the HTTP ceiling, not the pool. Three further runs at C = 400 hit a
leftover control server (see finding 6); they are kept as `c400-control-*` and serve as extra control runs.

## Findings

1. **The prediction missed on the metric and hit on the mechanism.** At 2.5·C for 30 s, unbounded had the
   *best* submit latency of the three (p99 0.85–1.2 s, no timeouts in three runs). But its growing cost was real.
   It landed on the consumer: block build reached 320 ms, inclusion fell from 400/s to 62–120/s, and the pool
   grew faster as a result, a spiral that the 30 s window did not bill to the producers. At C = 1000 the same
   spiral did reach them.
2. **A bound protects only if enforcing it is cheap.** Our eviction scans the whole pool on every add once full
   (ADR-0009). At 1000 adds/s a 10 000 pool needs 2.4 s of CPU per second, so it collapsed the moment it
   filled, in every run (49–50 % timeouts). ADR-0009's revisit condition is met.
3. **With headroom, the small bound is the best of the three.** At 1.5·C the 1 000 pool held p99 at 28 ms against
   162–173 ms, pinned depth, and capped the wait. The overload was paid by low fees: mean fee shed 15, included 68.
4. **Near the loop's limit, outcomes are metastable.** The 1 000 pool at 2.5·C should cost only 0.19 s of CPU per
   second, yet timed out 15 %, 34 %, 15 %, and 71 % in four runs, and the control alone ranged from p99 13 ms to
   994 ms. Once requests time out, k6 reconnects, which adds work, and the server does not recover.
5. **Averages hide starvation.** With priority-fee ordering, the median wait of included transactions stayed at
   0.1–0.4 s even with 22 000 queued, because high fees jump the line. Low fees waited 30–44 s.
6. **Experiment hygiene, again.** (a) No control run before the first attempt, so three runs measured the HTTP
   ceiling instead of the pool: week 1's lesson 7 repeated. (b) `a && b &` sends the whole list to the background
   and `$!` is the subshell, so a stale server survived and answered three later runs. The runner now refuses a
   busy port and checks that its own server is alive.

Next: make eviction O(log n) (a heap keyed by fee and arrival, with lazy deletion), then repeat the 2.5·C stage.

## Write-up

- Learning note: [docs/learning/week-03-backpressure.md](../../docs/learning/week-03-backpressure.md)
