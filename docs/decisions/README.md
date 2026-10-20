# Architecture Decision Records

The place for "why we chose this design". Only record the **reasoning** that cannot be recovered from the code or the git log.

- File name: `NNNN-kebab-title.md`; numbers only go up.
- To reverse a decision, do not edit the old ADR. Write a new one and link it with `Superseded by`.
- Status: `Proposed` → `Accepted` → (`Superseded` | `Deprecated`)

| # | Title | Status |
|---|---|---|
| [0001](0001-modular-monolith-first.md) | Start as a modular monolith | Accepted |
| [0002](0002-uv-workspace-python-monorepo.md) | Python in a uv workspace; TypeScript only inside apps/web | Accepted |
| [0003](0003-python-backend-typescript-ui.md) | Backend, engine, and experiments in Python; UI in TypeScript | Accepted |
| [0004](0004-integer-minimal-unit-amounts.md) | Amounts are integers in minimal units | Accepted |
| [0005](0005-k6-load-generator.md) | k6 for load generation; bot swarm in Python | Accepted |
| [0006](0006-module-placement.md) | Pure core in simulation_engine; all I/O in mev_arena_api | Accepted |
| [0007](0007-amm-and-execution-semantics.md) | AMM and execution semantics: scale 1e18, fee on input, revert-style failures, state hash | Accepted |
| [0008](0008-gateway-assigns-transaction-ids.md) | The gateway assigns transaction ids; a clash in the mempool is a bug | Accepted |
| [0009](0009-full-mempool-evicts-cheapest.md) | A full mempool evicts its cheapest transaction | Accepted |
| [0010](0010-expiry-rule-and-candidate-set.md) | Expiry is inclusive, checked at admission; the builder gets an arrival-ordered tuple | Accepted |

Template: [_template.md](_template.md)
