# 0004. Amounts are integers in minimal units (Python `int`)

- Status: Accepted
- Date: 2026-09-07
- Related: spec §9 data model

## Context

The spec forbids floating point and asks for "integer minimal units or a decimal with an explicit scale".
AMM `x * y = k` arithmetic and the state hash must be bit-identical across every node and every replay.

## Options considered

1. Integers in minimal units — simple determinism, stable hashes, same mental model as EVM wei / scale conversion needed for display
2. `decimal.Decimal` with a fixed scale — readable / the context (precision, rounding) is global state, a determinism risk; slower

## Decision

Option 1. Python `int` is arbitrary precision, so there is no overflow.
In API and event JSON, amounts are serialized as strings to avoid precision loss. PostgreSQL uses `NUMERIC`.
Division is always an explicit floor, and AMM output is rounded in the protocol's favour.

## Consequences

- Gain: no library; hash input is trivial
- Accept: a conversion layer is needed wherever a human reads the UI or logs
- Open: the scale (1e6 vs 1e18 etc.) is settled in week 2 together with the AMM and fee (bps) design
