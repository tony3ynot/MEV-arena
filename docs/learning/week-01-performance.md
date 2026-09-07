# Week 01 — Performance

> Learning notes. Experiment code and how to run it: [experiments/week-01-performance](../../experiments/week-01-performance/README.md).

## Question for the week

- When work is gated by a fixed-size pool, how do throughput and tail latency behave as load passes
  the pool's capacity, and can Little's law predict the knee before measuring it?

## Hypothesis

1. The knee can be predicted from C = N / S, and below C latency stays close to S.
2. The event loop's own capacity is around 2500 req/s, so for pool 64 (C = 3200) the loop, not the pool, will bind.

## Experiment design

A simulated pool (semaphore + sleep) behind FastAPI; k6 open-model load in four stages from 0.5·C to 1.5·C with a
cooldown between them; a `/stats` sampler to see where requests wait; server and generator pinned to separate cores.

## Results

The tables are in the experiment README. In short:

- Pools 1 and 4 matched the prediction within 5 %, and the wait growth at 1.5·C (0.5·t) was exact.
- At 1.1·C the prediction was off at every pool size: a 4 % lower capacity made the queue grow 50 % faster.
- The loop started to cost from pool 16 (measured / predicted = 0.88), earlier than expected.
- The loop's raw capacity was ≈ 4000, not 2500. Pool 64 still stopped at ≈ 2200 with the pool full, so the limit
  was not the loop's capacity but its latency: every slot hand-off waits for one loop iteration.
- Pool 128 (follow-up) reached ≈ 2900, not 4000: the hand-off wait grew with the backlog.
- Stages that hit the VU cap were invalid, and so was a control run with a missing env var.

## What I learned

1. Little's law predicted the knee. The 5 % it missed was `asyncio.sleep` waking on the next loop iteration,
   so S was 21 ms, not 20. How bad an overload is depends on λ / C, not on the pool size.
2. Prediction error is amplified near capacity: a 4 % error in C became a 50 % error in queue growth at 1.1·C
   and was invisible at 1.5·C. Keep headroom; do not run near the knee.
3. A slot hand-off is not free. Releasing a semaphore only schedules the next waiter, which runs on the next
   loop iteration, and iterations get long under a deep backlog (≈ 9 ms at pool 64, ≈ 24 ms at pool 128).
   A pool must be sized for S + loop latency, and a bigger pool has diminishing returns. Bounding the backlog
   is the real fix.
4. When the VU cap binds, an open-model test silently becomes a closed-model one: latency settles at
   VUs ÷ throughput, stays under the timeout, and a saturated server reports 0 % errors. Read
   `dropped_iterations` first.

## Questions carried to next week

- Does a bounded queue that rejects with 503 break the loop "backlog → long iteration → slower hand-off"? (week 3, backpressure)
- The block-execution loop in MEV Arena will pay the same hand-off cost. Where should it run so it never shares
  an event loop with the WebSocket fan-out?

## References

- Spec §14 SLOs, §20 study material (performance pages)
- k6 docs: open vs closed models, `dropped_iterations`
- Little's law
