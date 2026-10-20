# 0009. A full mempool evicts its cheapest transaction

- Status: Accepted
- Date: 2026-10-20
- Related: spec §8 Mempool ("Enforce a maximum queue size"), §14 targets, ADR-0008

## Context

The mempool must be bounded. When it is full and a new transaction arrives, something has to give. In MEV Arena
bots compete through priority fees, so this policy decides who can crowd whom out.

## Options considered

1. Reject the newcomer (tail drop). Simplest / a flood of zero-fee transactions locks out every higher bidder
2. Evict the cheapest stored transaction. The pool keeps what is worth most, and spam has to outbid real
   traffic / finding the cheapest costs a scan or a priority structure
3. Evict the oldest. Simple FIFO / drops a high-fee transaction for arriving early; expiry (`expires_at`)
   already removes old transactions

## Decision

Option 2, close to what geth's transaction pool does. Details:

- The newcomer must pay strictly more than the cheapest stored transaction. Otherwise the verdict is the new
  `POOL_FULL` and the pool is untouched, so equal fees never churn.
- Among equal lowest fees, the latest arrival goes first. Earlier arrivals keep their place, which matches the
  strictly-more rule above.
- `add()` returns `AdmissionResult(verdict, evicted)`, so the caller can tell the owner of an evicted
  transaction. The same field carries the transaction a `REPLACED` pushed out.
- A replacement never needs room: it frees the slot it takes.

`POOL_FULL` is kept apart from `UNDERPRICED` because it means something different: the system is saturated,
not that one account under-bid itself. Its count is a direct backpressure signal.

## Consequences

- Gain: cheap spam cannot hold the pool hostage; `POOL_FULL` gives the backpressure experiment a clean metric
- Accept: evicting an account's lower nonce strands its higher nonces until they expire. geth avoids this with
  a separate queue for future nonces; that is out of scope here
- Accept: finding the cheapest is an O(n) scan, and `max_size = 10_000` is a placeholder
- Revisit when the week-3 backpressure experiment shows the scan as the bottleneck (switch to a heap with lazy
  deletion) or produces a measured `max_size`
