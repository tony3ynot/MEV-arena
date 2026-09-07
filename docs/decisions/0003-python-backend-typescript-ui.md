# 0003. Backend, engine, and experiments in Python (FastAPI); UI in TypeScript

- Status: Accepted
- Date: 2026-09-07
- Related: spec §13 technology stack, §14 SLOs

## Context

The spec's default stack is TypeScript with Fastify or NestJS, but §13 opens with "prefer the language the developer knows best".
The developer is fluent in FastAPI and has no TS/Fastify/React experience. The budget is 8 weeks at 6–8 hours per week.
The learning goals of this project (event ordering, duplication, idempotency, backpressure, deterministic replay,
observability) are language-independent.

## Options considered

1. Everything in TypeScript — performance headroom, types shared through the workspace / learn a language, a framework, and React at the same time as Kafka, Postgres, Redis, and OTel
2. Python backend + Next.js UI — focus on the core in a familiar language / performance targets may be missed; the UI is still TS
3. Everything in Python (Streamlit etc.) — one language / hard to express sub-second real-time updates and pause/step/replay controls; visual quality suffers in a portfolio

## Decision

Option 2. `apps/api` is FastAPI; `packages/simulation-engine` is dependency-free pure Python; experiments are Python.
`apps/web` is Next.js with types generated from the OpenAPI schema (contract-first).
The engine runs under pyright strict and ruff. Determinism comes from seeded `random.Random` instances and hashes over canonical JSON.

## Consequences

- Gain: time goes to the domain and infrastructure. Python `int` is arbitrary precision, so amount handling is simple (ADR-0004). Property-based tests with `hypothesis`
- Accept: 5,000 submissions/s and 1,000-client WebSocket fan-out in a single Python process will saturate earlier than TS would, because of the GIL and single-threaded asyncio. Per spec §14 that is not failure; the saturation point, its cause, and before/after numbers get published
- Revisit when: week-7 load tests show a specific module (e.g. WebSocket broadcast, the execution loop) is bound by the Python runtime itself. Then move only that module to Rust, as spec §13 prescribes
