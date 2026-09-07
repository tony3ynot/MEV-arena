# 0006. Pure core in `simulation_engine`; every I/O boundary in `mev_arena_api`

- Status: Accepted
- Date: 2026-09-07
- Related: spec §7, §8, §12; ADR-0001, ADR-0003

## Context

Spec §7 names seven modules: gateway, mempool, block-builder, execution-engine, projection, bot-swarm, observability.
ADR-0001 keeps them in one process, so the open question is which package each module belongs to and which way
imports may point. Spec §12 requires that replaying the same snapshot, events, and seed yields the same state hash.
That is only cheap to test if the logic that produces state can run without a process, a database, or a clock.

## Options considered

1. One package, one directory per spec module, I/O mixed in — fastest start / replay tests need the whole app; boundaries erode
2. `simulation_engine` = pure core (mempool, block builder, execution, AMM, events, replay, bot strategies);
   `mev_arena_api` = every I/O boundary (HTTP/WS, PostgreSQL, Redis, Kafka, OTel) plus the simulation clock and the bot runner —
   replay is a pure function over recorded inputs; the boundary is a package boundary and can be linted
3. One package per spec module — clearest on paper / seven packages for one process is ceremony; shared types would need an eighth

## Decision

Option 2. Mapping:

| Spec module | Lives in | Notes |
|---|---|---|
| mempool | `simulation_engine.mempool` | pure; expiry uses the block clock passed in, never wall time |
| block-builder | `simulation_engine.block_builder` | each policy is a function of (candidates, capacity, seed) |
| execution-engine | `simulation_engine.execution`, plus `amm`, `models`, `events`, `replay` | |
| bot-swarm | strategies in `simulation_engine.bots`; runner in `mev_arena_api.bot_swarm` | decisions must be deterministic per seed (spec §5), so they are pure; submitting them is I/O |
| gateway | `mev_arena_api.gateway` | |
| projection | `mev_arena_api.projection` | |
| observability | `mev_arena_api.observability` | the engine emits plain events; it never imports OpenTelemetry |

Rules:

- `simulation_engine` imports only the standard library. Randomness is an injected, seeded `random.Random`.
  Time is a block height or a timestamp passed in as an argument. Enforced by an import-linter contract in the root `pyproject.toml`.
- `mev_arena_api` may import `simulation_engine`; never the reverse.
- Pydantic stays at the API boundary; engine models are frozen dataclasses.
- API-only modules (simulation clock/orchestrator, ledger, stream, snapshot store) are created when their milestone arrives. See [docs/architecture.md](../architecture.md).

## Consequences

- Gain: replay determinism is testable with pytest and hypothesis alone; property tests run in milliseconds
- Accept: some duplication between engine dataclasses and API schemas, and a translation layer at the boundary
- Revisit when: a module measured as a runtime bottleneck moves to Rust (ADR-0003), or the bot runner must become a
  separate process for load testing (it would then talk to the gateway over HTTP instead of calling it in-process)
