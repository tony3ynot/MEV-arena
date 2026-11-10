"""Wire format: engine objects -> the JSON frames declared in ``apps/web/lib/contract.ts``.

``contract.ts`` is the source of truth; each function here names the TypeScript type it produces.

- Keys are camelCase. The engine keeps its snake_case names; only this module renames.
- Token amounts, priority fees and fixed-point prices become base-10 strings: they exceed 2^53,
  which a JavaScript number cannot hold exactly. Small counters (height, nonce, position, bps,
  version, seed, capacity) stay JSON numbers.
- Enums go out as their ``.value``.

Pure functions, no I/O. The same module will serialize Kafka messages in week 5, so the stream
and the event log carry one format.
"""

import json
from collections.abc import Sequence
from typing import Literal, assert_never

from simulation_engine.block_builder import BuilderPolicy
from simulation_engine.events import (
    BlockCommitted,
    BlockProposed,
    Envelope,
    MarketPriceUpdated,
    Payload,
    SwapExecuted,
    TransactionAccepted,
    TransactionDropped,
    TransactionExecuted,
    TransactionRejected,
)
from simulation_engine.models import ExecutionReceipt, MarketState, Transaction, TransactionStatus

Json = dict[str, object]
SimulationStatus = Literal["running", "paused"]
ACCOUNT_KINDS = ("noise", "arb", "sandwich", "user")
MAX_SAFE_INTEGER = 2**53 - 1
"""Largest integer a JSON number carries exactly into JavaScript."""


def _amount(value: int) -> str:
    return str(value)


def _optional_amount(value: int | None) -> str | None:
    return None if value is None else str(value)


# ---- state ---------------------------------------------------------------------------------------


def tx_json(tx: Transaction) -> Json:
    """``Tx``: a pending transaction."""
    return {
        "id": tx.id,
        "idempotencyKey": tx.idempotency_key,
        "accountId": tx.account_id,
        "nonce": tx.nonce,
        "marketId": tx.market_id,
        "side": tx.side.value,
        "amountIn": _amount(tx.amount_in),
        "minAmountOut": _amount(tx.min_amount_out),
        "priorityFee": _amount(tx.priority_fee),
        "submittedAt": tx.submitted_at,
        "expiresAt": tx.expires_at,
    }


def market_json(market: MarketState, reference_price: int | None = None) -> Json:
    """``Market``. ``reference_price`` is the arbitrage bot's target, if the caller has one."""
    return {
        "marketId": market.market_id,
        "baseAsset": market.base_asset,
        "quoteAsset": market.quote_asset,
        "baseReserve": _amount(market.base_reserve),
        "quoteReserve": _amount(market.quote_reserve),
        "feeBps": market.fee_bps,
        "price": _amount(market.last_price),
        "version": market.version,
        "referencePrice": _optional_amount(reference_price),
    }


def receipt_json(tx: Transaction, receipt: ExecutionReceipt) -> Json:
    """``Receipt``: one transaction's result inside a block. ``tx`` supplies account and side."""
    if tx.id != receipt.transaction_id:
        raise ValueError(f"receipt {receipt.transaction_id} is not for transaction {tx.id}")
    return {
        "transactionId": receipt.transaction_id,
        "accountId": tx.account_id,
        "position": receipt.position,
        "status": receipt.status.value,
        "side": tx.side.value,
        "amountIn": _amount(receipt.amount_in),
        "amountOut": _amount(receipt.amount_out),
        "slippageBps": receipt.slippage_bps,
        "errorCode": None if receipt.error_code is None else receipt.error_code.value,
    }


def block_summary_json(
    *,
    height: int,
    policy: BuilderPolicy,
    block: Sequence[Transaction],
    receipts: Sequence[ExecutionReceipt],
    state_root: str,
) -> Json:
    """``BlockSummary``. ``block`` and ``receipts`` in execution order."""
    if len(block) != len(receipts):
        raise ValueError(f"block {height}: {len(block)} transactions, {len(receipts)} receipts")
    executed = sum(r.status is TransactionStatus.EXECUTED for r in receipts)
    return {
        "height": height,
        "policy": policy.value,
        "transactionIds": [tx.id for tx in block],
        "executed": executed,
        "failed": len(receipts) - executed,
        "stateRoot": state_root,
        "receipts": [receipt_json(tx, r) for tx, r in zip(block, receipts, strict=True)],
    }


def account_kind(account_id: str) -> str:
    """The contract names accounts ``{kind}-{n}``, e.g. ``noise-3``."""
    kind = account_id.split("-", 1)[0]
    if kind not in ACCOUNT_KINDS:
        raise ValueError(f"account id {account_id!r} does not start with one of {ACCOUNT_KINDS}")
    return kind


def account_info_json(
    account_id: str,
    *,
    start_base: int,
    start_quote: int,
    base_balance: int,
    quote_balance: int,
) -> Json:
    """``AccountInfo``: start balances and balances as of the snapshot."""
    return {
        "accountId": account_id,
        "kind": account_kind(account_id),
        "startBase": _amount(start_base),
        "startQuote": _amount(start_quote),
        "baseBalance": _amount(base_balance),
        "quoteBalance": _amount(quote_balance),
    }


def simulation_state_json(
    *,
    status: SimulationStatus,
    height: int,
    policy: BuilderPolicy,
    seed: int,
    capacity: int,
    block_interval_ms: int,
    next_block_at: str | None,
) -> Json:
    """``SimulationState``. ``next_block_at`` is RFC 3339, or None while paused."""
    if not 0 <= seed <= MAX_SAFE_INTEGER:
        raise ValueError(f"seed {seed} does not fit a JSON number (0..2^53-1)")
    return {
        "status": status,
        "height": height,
        "policy": policy.value,
        "seed": seed,
        "capacity": capacity,
        "blockIntervalMs": block_interval_ms,
        "nextBlockAt": next_block_at,
    }


# ---- events --------------------------------------------------------------------------------------


def payload_json(payload: Payload) -> Json:
    """The payload of one spec §11 event; its type picks the shape."""
    match payload:
        case TransactionAccepted():
            return {"transaction": tx_json(payload.transaction)}
        case TransactionRejected():
            return {
                "idempotencyKey": payload.idempotency_key,
                "accountId": payload.account_id,
                "reason": payload.reason.value,
            }
        case TransactionDropped():
            return {"transactionId": payload.transaction_id, "reason": payload.reason}
        case BlockProposed():
            return {
                "height": payload.height,
                "policy": payload.policy.value,
                "transactionIds": list(payload.transaction_ids),
            }
        case TransactionExecuted():
            return {
                "transactionId": payload.transaction_id,
                "blockHeight": payload.block_height,
                "position": payload.position,
                "status": payload.status.value,
                "errorCode": None if payload.error_code is None else payload.error_code.value,
            }
        case SwapExecuted():
            return {
                "transactionId": payload.transaction_id,
                "marketId": payload.market_id,
                "accountId": payload.account_id,
                "side": payload.side.value,
                "amountIn": _amount(payload.amount_in),
                "amountOut": _amount(payload.amount_out),
                "effectivePrice": _amount(payload.effective_price),
                "slippageBps": payload.slippage_bps,
                "feePaid": _amount(payload.fee_paid),
            }
        case MarketPriceUpdated():
            return {
                "marketId": payload.market_id,
                "price": _amount(payload.price),
                "baseReserve": _amount(payload.base_reserve),
                "quoteReserve": _amount(payload.quote_reserve),
                "version": payload.version,
            }
        case BlockCommitted():
            return {
                "height": payload.height,
                "stateRoot": payload.state_root,
                "transactionIds": list(payload.transaction_ids),
                "executed": payload.executed,
                "failed": payload.failed,
            }
        case _:
            assert_never(payload)


def envelope_json(envelope: Envelope) -> Json:
    """``Envelope``: the spec §11 common fields around one payload."""
    return {
        "eventId": envelope.event_id,
        "eventType": envelope.event_type,
        "eventVersion": envelope.event_version,
        "aggregateId": envelope.aggregate_id,
        "occurredAt": envelope.occurred_at,
        "correlationId": envelope.correlation_id,
        "causationId": envelope.causation_id,
        "payload": payload_json(envelope.payload),
    }


# ---- frames (WS /v1/stream) ----------------------------------------------------------------------


def snapshot_frame(
    *,
    simulation: Json,
    market: Json,
    mempool: Sequence[Transaction],
    recent_blocks: Sequence[Json],
    accounts: Sequence[Json],
) -> Json:
    """``SnapshotFrame``. ``mempool`` in arrival order, ``recent_blocks`` ascending by height."""
    return {
        "kind": "snapshot",
        "simulation": simulation,
        "market": market,
        "mempool": [tx_json(tx) for tx in mempool],
        "recentBlocks": list(recent_blocks),
        "accounts": list(accounts),
    }


def event_frame(envelope: Envelope) -> Json:
    """``EventFrame``."""
    return {"kind": "event", "event": envelope_json(envelope)}


def simulation_frame(state: Json) -> Json:
    """``SimulationFrame``: ``state`` from ``simulation_state_json``."""
    return {"kind": "simulation", "state": state}


def dumps(frame: Json) -> str:
    """One frame as compact JSON text, ready for a WebSocket message or a Kafka value."""
    return json.dumps(frame, separators=(",", ":"), allow_nan=False)
