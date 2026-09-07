# 0002. Python in a uv workspace; TypeScript only inside apps/web

- Status: Accepted
- Date: 2026-09-07
- Related: ADR-0003, spec §13

## Context

ADR-0003 puts the backend, engine, and experiments in Python and only the UI in TypeScript.
`apps/api` and `experiments/*` must import `packages/simulation-engine`, and a new experiment appears most weeks.
The first attempt was a pnpm workspace over the whole repo; it assumed TypeScript everywhere and was dropped.

## Options considered

1. pnpm workspace over everything — assumes a TS monorepo; cannot express Python packages
2. uv workspace for Python + `apps/web` as a standalone npm project — the standard tool of each ecosystem; one `uv sync` at the root
3. poetry / pip-tools — weak workspace support, slower; each experiment would need its own venv

## Decision

Option 2. The root `pyproject.toml` is the workspace root; members are `apps/api`, `packages/simulation-engine`, and `experiments/*`.
Because `experiments/*` are all members, every experiment folder must have a `pyproject.toml` (uv fails otherwise).
That forces each experiment to declare its dependencies; script-only experiments set `[tool.uv] package = false`.
Adding an experiment never touches the root. Full install is `uv sync --all-packages`.
`apps/web` gets its own `package.json` when Next.js is scaffolded in week 4; its types come from the OpenAPI schema FastAPI generates.
`uv.lock` is committed.

## Consequences

- Gain: a single `.venv`; experiments reference the engine with `workspace = true`; lint/test config in one place
- Accept: contributors install `uv`, and Node separately when working on the UI
- Revisit when: the UI grows into several packages, or part of the engine moves to Rust and a build graph is needed
