# 0001. Start as a modular monolith

- Status: Accepted
- Date: 2026-09-07
- Related: spec §7 deployment strategy, §6 non-goals

## Context

The spec defines seven modules: gateway, mempool, block-builder, execution-engine, projection, bot-swarm, observability.
"Microservices" would look good in a portfolio, but with a budget of 8 weeks at 6–8 hours per week, splitting services
means paying for network boundaries, deployment, and contract versioning before anything works. We also have no
measurements yet showing where the bottleneck is.

## Options considered

1. One process per service from day one — easy to narrate scaling / freezes boundaries before measuring, complicates local runs, too slow
2. One process, module boundaries kept only at the code level (packages / directories) — fast, determinism tests are simple / boundaries can erode
3. Monolith with only the event stream (Kafka) externalized — like 2, but naturally prepares a split from week 5

## Decision

Option 2, moving to option 3 when the event stream arrives in week 5.
Module boundaries are enforced as `packages/simulation-engine` (domain) plus module directories inside `apps/api`
(see ADR-0006). Deployment units are split in v0.2 **only for components that load testing shows need independent scaling**.

## Consequences

- Gain: fast iteration; deterministic replay can be verified inside a single process
- Accept: import discipline between modules must be kept by people (backed by an import-linter contract, ADR-0006)
- Revisit when: week-7 load tests show a specific module sets the saturation point
