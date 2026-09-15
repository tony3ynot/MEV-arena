"""Domain event types and the common envelope (spec §11).

The engine defines the *shapes* and derives payloads from execution results; it never mints
``event_id`` / ``occurred_at`` / ``correlation_id``. Those are I/O and are stamped by
``mev_arena_api`` when it wraps a payload in an ``Envelope``. Replay (week 6) reads envelopes
back, so the envelope type has to live here.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from simulation_engine.execution import WorldState
from simulation_engine.models import (
    ErrorCode,
    ExecutionReceipt,
    Side,
    Transaction,
    TransactionStatus,
)

EventType = Literal[
    "TransactionSubmitted",
    "TransactionAccepted",
    "TransactionRejected",
    "BlockProposed",
    "TransactionExecuted",
    "SwapExecuted",
    "BlockCommitted",
    "MarketPriceUpdated",
    "SnapshotCreated",
    "ProjectionRebuilt",
]


@dataclass(frozen=True, slots=True)
class TransactionExecuted:
    transaction_id: str
    block_height: int
    position: int
    status: TransactionStatus
    error_code: ErrorCode | None


@dataclass(frozen=True, slots=True)
class SwapExecuted:
    transaction_id: str
    market_id: str
    account_id: str
    side: Side
    amount_in: int
    amount_out: int
    effective_price: int
    slippage_bps: int
    fee_paid: int


@dataclass(frozen=True, slots=True)
class MarketPriceUpdated:
    market_id: str
    price: int
    base_reserve: int
    quote_reserve: int
    version: int


@dataclass(frozen=True, slots=True)
class BlockCommitted:
    height: int
    state_root: str
    transaction_ids: tuple[str, ...]
    executed: int
    failed: int


Payload = TransactionExecuted | SwapExecuted | MarketPriceUpdated | BlockCommitted


@dataclass(frozen=True, slots=True)
class Envelope:
    """Spec §11 common envelope. Amounts inside ``payload`` stay ``int``; JSON encoding is I/O."""

    event_id: str
    event_type: EventType
    event_version: int
    aggregate_id: str
    occurred_at: str
    correlation_id: str
    causation_id: str
    payload: Payload


def events_for_block(
    txs: Sequence[Transaction],
    receipts: Sequence[ExecutionReceipt],
    state_after: WorldState,
    height: int,
    state_root: str,
) -> tuple[Payload, ...]:
    """Derive the payloads one committed block produces, in emission order.

    Per transaction: ``TransactionExecuted`` (always) then ``SwapExecuted`` (if it executed).
    Then one ``MarketPriceUpdated`` per market touched, then ``BlockCommitted``.
    """
    out: list[Payload] = []
    touched: dict[str, None] = {}
    for tx, r in zip(txs, receipts, strict=True):
        out.append(
            TransactionExecuted(r.transaction_id, height, r.position, r.status, r.error_code)
        )
        if r.status is TransactionStatus.EXECUTED:
            touched[tx.market_id] = None
            out.append(
                SwapExecuted(
                    tx.id,
                    tx.market_id,
                    tx.account_id,
                    tx.side,
                    r.amount_in,
                    r.amount_out,
                    r.effective_price,
                    r.slippage_bps,
                    r.fee_paid,
                )
            )
    for market_id in touched:
        m = state_after.markets[market_id]
        out.append(
            MarketPriceUpdated(market_id, m.last_price, m.base_reserve, m.quote_reserve, m.version)
        )
    executed = sum(r.status is TransactionStatus.EXECUTED for r in receipts)
    out.append(
        BlockCommitted(
            height, state_root, tuple(t.id for t in txs), executed, len(receipts) - executed
        )
    )
    return tuple(out)
