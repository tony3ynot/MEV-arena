"""Frozen dataclasses for the spec §9 data model.

Transaction, Block, ExecutionReceipt, AccountBalance, MarketState. No pydantic here.
Amounts are ``int`` in minimal units (ADR-0004); ``SCALE`` = units per whole token.
"""

from dataclasses import dataclass
from enum import StrEnum

SCALE = 10**18
"""Minimal units per whole token, EVM-style (1 token = 1e18 units)."""

BPS = 10_000
"""Basis points in 100 %."""


class Side(StrEnum):
    BUY = "buy"  # pay quote, receive base
    SELL = "sell"  # pay base, receive quote


class TransactionStatus(StrEnum):
    PENDING = "pending"
    EXECUTED = "executed"
    FAILED = "failed"
    REJECTED = "rejected"
    EXPIRED = "expired"


class ErrorCode(StrEnum):
    SLIPPAGE = "slippage"
    INSUFFICIENT_BALANCE = "insufficient_balance"
    BAD_NONCE = "bad_nonce"
    UNKNOWN_MARKET = "unknown_market"


@dataclass(frozen=True, slots=True)
class MarketState:
    market_id: str
    base_reserve: int
    quote_reserve: int
    fee_bps: int
    version: int = 0

    @property
    def last_price(self) -> int:
        """Spot price of one base in quote, as a fixed-point int with ``SCALE`` decimals."""
        return self.quote_reserve * SCALE // self.base_reserve

    @property
    def k(self) -> int:
        return self.base_reserve * self.quote_reserve


@dataclass(frozen=True, slots=True)
class Transaction:
    id: str
    idempotency_key: str
    account_id: str
    nonce: int
    market_id: str
    side: Side
    amount_in: int
    min_amount_out: int
    priority_fee: int
    submitted_at: int  # block height or ms timestamp supplied by the caller, never wall time
    expires_at: int


@dataclass(frozen=True, slots=True)
class ExecutionReceipt:
    transaction_id: str
    block_height: int
    position: int
    status: TransactionStatus
    amount_in: int
    amount_out: int
    effective_price: int
    slippage_bps: int
    fee_paid: int
    error_code: ErrorCode | None = None


@dataclass(frozen=True, slots=True)
class AccountBalance:
    account_id: str
    asset: str
    available_amount: int
    version: int = 0


@dataclass(frozen=True, slots=True)
class Block:
    height: int
    parent_hash: str
    block_hash: str
    builder_policy: str
    simulation_seed: int
    state_root: str
    transaction_ids: tuple[str, ...]
