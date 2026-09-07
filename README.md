# MEV Arena

An educational simulator in which thousands of virtual traders and strategy bots compete in a public mempool,
and the block builder's transaction ordering changes what an AMM actually executes. All of it visible in real time.

> **No real assets.** Every token, balance, and profit here is simulated. Nothing in this project is investment advice or a live trading strategy.

This is a portfolio project for learning large-scale real-time systems: event streams, deterministic execution,
replay, backpressure, observability. Full specification: [MEV_ARENA_SPEC.md](MEV_ARENA_SPEC.md)

## Layout

```
apps/api                    FastAPI service + WebSocket gateway; all I/O lives here   (Python)
apps/web                    UI; types generated from the OpenAPI schema               (Next.js / TS)
packages/simulation-engine  AMM · mempool · block builder · execution; pure core     (Python, stdlib only)
experiments/week-NN-*       one-off learning experiments: hypothesis · how to run · results (Python + k6)
benchmarks/                 repeatable performance regression tests only              (k6)
docs/architecture.md        where each spec module lives and which way imports may point
docs/learning/              weekly learning notes
docs/decisions/             ADRs: why this design
docker-compose.yml          local stack, services added milestone by milestone
```

Key design decisions live in [docs/decisions](docs/decisions/README.md): why Python, why a modular monolith,
how amounts are represented, where the module boundaries are.

## Status

| Week | Goal | Status |
|---|---|---|
| 1 | Requirements, SLOs, architecture, ADRs | in progress |
| 2 | AMM + deterministic execution engine | |
| 3 | Mempool, block builder | |
| 4 | Three bots, real-time UI, v0.0.1 | |
| 5 | Kafka/Redpanda event pipeline | |
| 6 | PostgreSQL ledger, Redis projection, snapshot/replay | |
| 7 | OpenTelemetry, Grafana, load and failure tests | |
| 8 | Docs, demo, v0.1 | |

## Running

Nothing runnable yet. To set up the development environment:

```bash
uv sync --all-packages   # whole Python workspace: apps/api, packages/*, experiments/*
uv run pytest
uv run ruff check . && uv run pyright && uv run lint-imports
```

The load generator, k6, is installed separately: https://grafana.com/docs/k6/latest/set-up/install-k6/

## License

MIT
