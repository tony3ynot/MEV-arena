"""Execute an ordered block against world state.

Checks run in the order nonce → balance → swap → min_amount_out and stop at the first failure.
A failed transaction still consumes its nonce and produces a receipt, but changes nothing else
(EVM-revert style). Every function is pure: ``(state, input) -> (new state, outputs)``.
"""

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace

from simulation_engine.amm import apply_swap, fee_of, slippage_bps
from simulation_engine.models import (
    SCALE,
    AccountBalance,
    ErrorCode,
    ExecutionReceipt,
    MarketState,
    Side,
    Transaction,
    TransactionStatus,
)

BalanceKey = tuple[str, str]
"""(account_id, asset)"""


@dataclass(frozen=True, slots=True)
class WorldState:
    """Everything a block executes against. Mappings are immutable by convention."""

    markets: Mapping[str, MarketState] = field(default_factory=dict[str, MarketState])
    balances: Mapping[BalanceKey, AccountBalance] = field(
        default_factory=dict[BalanceKey, AccountBalance]
    )
    nonces: Mapping[str, int] = field(default_factory=dict[str, int])
    """account_id -> next expected nonce (0 for an account that has never transacted)."""

    def balance_of(self, account_id: str, asset: str) -> int:
        bal = self.balances.get((account_id, asset))
        return bal.available_amount if bal else 0

    def next_nonce(self, account_id: str) -> int:
        return self.nonces.get(account_id, 0)


def _with_balance(state: WorldState, account_id: str, asset: str, delta: int) -> WorldState:
    key = (account_id, asset)
    old = state.balances.get(key) or AccountBalance(account_id, asset, 0)
    new = AccountBalance(account_id, asset, old.available_amount + delta, old.version + 1)
    return replace(state, balances={**state.balances, key: new})


def _fail(
    state: WorldState, tx: Transaction, height: int, position: int, code: ErrorCode
) -> tuple[WorldState, ExecutionReceipt]:
    receipt = ExecutionReceipt(
        transaction_id=tx.id,
        block_height=height,
        position=position,
        status=TransactionStatus.FAILED,
        amount_in=tx.amount_in,
        amount_out=0,
        effective_price=0,
        slippage_bps=0,
        fee_paid=0,
        error_code=code,
    )
    return state, receipt


def execute_transaction(
    state: WorldState, tx: Transaction, block_height: int, position: int
) -> tuple[WorldState, ExecutionReceipt]:
    """Apply one transaction. The nonce is consumed whether or not the swap succeeds."""
    if tx.nonce != state.next_nonce(tx.account_id):
        # A wrong nonce is the one failure that does *not* consume a nonce: the account's
        # sequence must stay intact so the correctly-numbered transaction can still land.
        return _fail(state, tx, block_height, position, ErrorCode.BAD_NONCE)
    state = replace(state, nonces={**state.nonces, tx.account_id: tx.nonce + 1})

    market = state.markets.get(tx.market_id)
    if market is None:
        return _fail(state, tx, block_height, position, ErrorCode.UNKNOWN_MARKET)

    if tx.side is Side.SELL:
        asset_in, asset_out = market.base_asset, market.quote_asset
    else:
        asset_in, asset_out = market.quote_asset, market.base_asset

    if state.balance_of(tx.account_id, asset_in) < tx.amount_in:
        return _fail(state, tx, block_height, position, ErrorCode.INSUFFICIENT_BALANCE)

    new_market, amount_out = apply_swap(market, tx.side, tx.amount_in)
    if amount_out < max(tx.min_amount_out, 1):  # a zero fill is a failure, as in Uniswap v2
        return _fail(state, tx, block_height, position, ErrorCode.SLIPPAGE)

    state = replace(state, markets={**state.markets, tx.market_id: new_market})
    state = _with_balance(state, tx.account_id, asset_in, -tx.amount_in)
    state = _with_balance(state, tx.account_id, asset_out, amount_out)

    if tx.side is Side.SELL:
        effective_price = amount_out * SCALE // tx.amount_in
    else:
        effective_price = tx.amount_in * SCALE // amount_out
    receipt = ExecutionReceipt(
        transaction_id=tx.id,
        block_height=block_height,
        position=position,
        status=TransactionStatus.EXECUTED,
        amount_in=tx.amount_in,
        amount_out=amount_out,
        effective_price=effective_price,
        slippage_bps=slippage_bps(tx.amount_in, amount_out, market.last_price, tx.side),
        fee_paid=fee_of(tx.amount_in, market.fee_bps),
    )
    return state, receipt


def execute_block(
    state: WorldState, txs: Sequence[Transaction], block_height: int
) -> tuple[WorldState, tuple[ExecutionReceipt, ...]]:
    """Apply ``txs`` in the given order. Order is the block builder's decision, not ours."""
    receipts: list[ExecutionReceipt] = []
    for position, tx in enumerate(txs):
        state, receipt = execute_transaction(state, tx, block_height, position)
        receipts.append(receipt)
    return state, tuple(receipts)


def canonical_json(state: WorldState) -> str:
    """Deterministic serialization: sorted keys, amounts as strings, no whitespace."""
    doc = {
        "markets": {
            m.market_id: {
                "base_asset": m.base_asset,
                "quote_asset": m.quote_asset,
                "base_reserve": str(m.base_reserve),
                "quote_reserve": str(m.quote_reserve),
                "fee_bps": m.fee_bps,
                "version": m.version,
            }
            for m in state.markets.values()
        },
        "balances": {
            f"{b.account_id}/{b.asset}": {"amount": str(b.available_amount), "version": b.version}
            for b in state.balances.values()
        },
        "nonces": dict(state.nonces),
    }
    return json.dumps(doc, sort_keys=True, separators=(",", ":"))


def state_hash(state: WorldState) -> str:
    return hashlib.sha256(canonical_json(state).encode()).hexdigest()
