# 0007. AMM and execution semantics: scale 1e18, fee on input, revert-style failures, canonical-JSON state hash

- Status: Accepted
- Date: 2026-09-15
- Related: spec §5, §9, §12; ADR-0004 (closes its open question), ADR-0006

## Context

ADR-0004 fixed "integers in minimal units" but left the scale open. Week 2 builds the AMM and the execution
engine, which forces four more choices: how the fee is taken, what happens to a transaction that fails inside
a block, what the state hash is computed over, and how rounding is reported to users.

## Options considered

1. Scale: 1e6 (fewer digits to read) vs **1e18** (same mental model as EVM wei; Python `int` makes the size free)
2. Fee: on input, Uniswap-v2 style (`in · (10000 − fee_bps)` enters the invariant) vs on output vs a separate fee ledger
3. Failed transaction: **included in the block with a `failed` receipt, no state change** (EVM revert) vs dropped
   from the block. Sub-question: does a failed transaction consume its nonce?
4. State hash: sha256 over canonical JSON (sorted keys, amounts as strings, no whitespace) of markets + balances + nonces,
   vs a Merkle tree

## Decision

- **1e18.** `SCALE = 10**18`; prices are fixed-point ints with the same scale (`quote · SCALE // base`).
- **Fee on input**, 30 bps default per market. `out = R_out · in' // (R_in · 10000 + in')`, `in' = in · (10000 − fee)`.
  Floor division only, so `k` never decreases (property-tested with hypothesis).
- **Revert-style failures.** Checks run `nonce → balance → swap → min_amount_out` and stop at the first failure.
  A failed transaction consumes its nonce and changes nothing else. Exception: `BAD_NONCE` does *not* consume a nonce,
  otherwise one mis-numbered submission would strand the account's correctly numbered transactions.
  A fill of 0 units is a failure (`SLIPPAGE`), as in Uniswap v2; this also avoids a zero division in the
  effective price.
- **Canonical JSON + sha256.** Simple to inspect and to diff when a replay disagrees. A Merkle tree is only
  worth it when partial proofs are needed, which v0.1 does not.
- `MarketState` carries `base_asset` / `quote_asset`; all engine updates go through `dataclasses.replace`
  so new fields cannot be silently dropped (a hypothesis conservation test caught exactly that bug).

## Consequences

- Gain: hand calculations and code agree to the unit; `k ≥ k_prev`, asset conservation, and
  "same input ⇒ same hash / different order ⇒ different hash" are unit tests
- Accept: every division floors in the pool's favour, including the *reported* slippage, so a user sees
  39 bps where the exact value is 39.93. A display layer may round differently; the engine does not
- Accept: a display layer must divide by 1e18 everywhere a human reads a number
- Revisit when: the projection (week 6) needs proofs over partial state, or a second market type needs a
  different fee model
