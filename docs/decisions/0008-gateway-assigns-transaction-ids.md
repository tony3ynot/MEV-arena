# 0008. The gateway assigns transaction ids; a clash in the mempool is a bug

- Status: Accepted
- Date: 2026-10-20
- Related: spec §9 Transaction, §10 Core API, ADR-0006

## Context

A transaction carries two identifiers: `idempotency_key`, which the client sends in the `Idempotency-Key` header,
and `id`. The spec does not say who creates `id`. The mempool indexes by both.

A hypothesis state-machine test found that a transaction whose `id` was already pooled under a different key
silently overwrote the stored one. The old key and `(account, nonce)` entries kept pointing at a transaction that
no longer existed, so later admissions returned wrong verdicts or raised `KeyError`.

## Options considered

1. The gateway assigns `id`; the mempool raises `ValueError` on a clash. Bugs surface at once / every caller
   (gateway, replay, tests) must supply unique ids
2. Reject with the existing `CONFLICT` verdict. No new code path / a bug on our side looks like an ordinary
   client rejection and is counted as one
3. A new `ID_CONFLICT` verdict. The cause is visible / still models an impossible client action as a normal
   outcome, and widens the verdict set the API must expose

## Decision

Option 1. Clients send only the idempotency key and never choose `id`, so they cannot cause a clash.
Verdicts describe what a client can do (retry, reuse a nonce, bump a fee). Exceptions describe what only our own
code can get wrong.

## Consequences

- Gain: an id clash fails loudly at the mempool instead of corrupting its indexes
- Accept: the gateway owns id generation; replay reuses the ids recorded in `TransactionSubmitted` instead of
  minting new ones
- Revisit if clients ever choose their own ids (for example `id = hash(signed payload)`), which would make a clash
  a client error and call for a verdict
