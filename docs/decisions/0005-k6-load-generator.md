# 0005. k6 for load generation; bot swarm in Python

- Status: Accepted
- Date: 2026-09-07
- Related: spec §15 load testing, ADR-0003

## Context

The load generator and the server under test share one machine (6C/12T, ~7 GB). If the generator saturates before
the server does, the measurement is contaminated. A Python generator has the same GIL ceiling as the server.

## Options considered

1. k6 — standalone Go binary, high rps, built-in p50/p95/p99, WebSocket support / scenarios are JS; separate install
2. locust or asyncio + httpx — one language / low generator ceiling; "who is the bottleneck" becomes ambiguous

## Decision

Option 1. HTTP and WebSocket load comes from k6. The bot swarm, which needs domain logic (strategies, nonces,
market detection), stays in Python and reuses the engine. k6 scenario scripts are kept short.

## Consequences

- Gain: generator bottleneck ruled out; standardized metrics
- Accept: installing k6; a minimal amount of JS
- Revisit when: k6 itself cannot reach the target rps on this machine; then move the generator to another host
