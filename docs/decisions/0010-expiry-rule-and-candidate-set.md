# 0010. Expiry is inclusive, checked at admission, and the builder gets an arrival-ordered tuple

- Status: Accepted
- Date: 2026-10-20
- Related: spec §8 Mempool and Block Builder, ADR-0006, ADR-0009

## Context

The mempool must evict expired transactions and hand the block builder an immutable candidate set. Three small
choices hide in that sentence: what "expired" means at the boundary, when it is checked, and what shape and order
the candidate set has.

## Options considered

1. Boundary: `expires_at` is the last valid block (`expires_at < height` means expired) / or the first invalid
   one (`expires_at <= height`). Either works; what matters is that every module uses the same comparison
2. When to check: only in a per-block sweep / also at admission. Sweep-only lets a transaction that is already
   dead evict a live one from a full pool (ADR-0009) before the sweep removes it
3. Candidate order: whatever the dict yields / sorted by arrival. Dict order happens to match arrival today, but
   only by accident of how `add` and `remove` are written

## Decision

- `expires_at` is the last block a transaction may be included in. The rule lives in one place,
  `Transaction.is_expired(height)`, and nothing else compares heights.
- `add()` takes the current `height` (keyword-only) and rejects a dead-on-arrival transaction with `EXPIRED`
  before the capacity check.
- `expire(height)` sweeps the pool and returns the dropped ids in arrival order, so the caller can report them.
- `candidates()` returns a tuple sorted by arrival. A FIFO builder uses it as is; other policies re-sort it.

Per block, the caller runs `expire(height)`, then `candidates()`, then the builder.

## Consequences

- Gain: one expiry rule; a dead transaction can never cost a live one its place
- Accept: `candidates()` sorts on every call, O(n log n) per block
- Accept: every `add()` caller must know the current height
- Revisit if the backpressure experiment shows the per-block sort matters
