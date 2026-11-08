"""Bot strategies as pure decision functions of observed state and a seeded RNG.

NoiseTrader, ArbitrageBot, SandwichBot. Submission lives in the API, not here.
A bot keeps no state of its own: everything it knows is in its ``BotView``, so the same view and
the same seed always give the same orders, and a replay needs nothing saved about the bots.
"""

import random
from dataclasses import dataclass
from typing import Protocol

from simulation_engine.amm import apply_swap
from simulation_engine.execution import WorldState
from simulation_engine.models import SCALE, MarketState, Side, Transaction


@dataclass(frozen=True, slots=True)
class BotView:
    """What a bot sees when it decides. Public information only."""

    height: int
    state: WorldState
    """Last committed state: reserves, balances, nonces."""
    pending: tuple[Transaction, ...]
    """The public mempool in arrival order, as ``Mempool.candidates()`` gives it."""
    reference_price: int
    """External price of one base in quote, ``SCALE`` decimals. The arbitrage bot's signal."""


@dataclass(frozen=True, slots=True)
class Order:
    """A transaction as a bot wants it, before the gateway assigns an id (ADR-0008)."""

    account_id: str
    nonce: int
    market_id: str
    side: Side
    amount_in: int
    min_amount_out: int
    priority_fee: int
    expires_at: int

    def to_transaction(self, id: str, idempotency_key: str, submitted_at: int) -> Transaction:
        return Transaction(
            id,
            idempotency_key,
            self.account_id,
            self.nonce,
            self.market_id,
            self.side,
            self.amount_in,
            self.min_amount_out,
            self.priority_fee,
            submitted_at,
            self.expires_at,
        )


class Bot(Protocol):
    @property
    def account_id(self) -> str: ...

    def decide(self, view: BotView, rng: random.Random) -> tuple[Order, ...]: ...


def max_front_run(market: MarketState, victim: Transaction, balance: int) -> int:
    """Largest front-run, in the victim's input asset, that still lets ``victim`` fill.

    The front-run trades the same side as the victim, immediately before it. Returns ``f`` in
    ``[0, balance]`` such that the victim still meets ``min_amount_out`` after a front-run of ``f``
    and would not after ``f + 1``. 0 if the victim cannot fill even without one.
    """

    def fills(front: int) -> bool:
        m = market
        if front > 0:
            moved, front_out = apply_swap(m, victim.side, front)
            if front_out >= 1:
                m = moved
        _, out = apply_swap(m, victim.side, victim.amount_in)
        return out >= max(victim.min_amount_out, 1)

    if not fills(0):
        return 0

    lo, hi = 0, balance

    while lo < hi:
        mid = (lo + hi + 1) // 2
        if fills(mid):
            lo = mid
        else:
            hi = mid - 1

    return lo


def _opposite(side: Side) -> Side:
    return Side.BUY if side is Side.SELL else Side.SELL


@dataclass(frozen=True, slots=True)
class SandwichBot:
    """Front-runs and back-runs the most profitable pending swap it can find.

    For the victim it picks, it submits two orders. The front-run trades the victim's side, is
    sized by ``max_front_run`` against the bot's balance, and carries the bot's next nonce n.
    The back-run trades the opposite side, spends everything the front-run receives, and carries
    n + 1. Both expire with the victim, and their fees must make a priority-fee builder place
    them front-run → victim → back-run.

    A victim is worth it only if that sandwich, simulated on ``view.state``, ends with more of
    the victim's input asset than the front-run spent. Among those, the bot takes the largest
    profit, valued in quote at the pool price. It does nothing while any of its own
    transactions is still pending: one sandwich at a time.
    """

    account_id: str

    def decide(self, view: BotView, rng: random.Random) -> tuple[Order, ...]:
        if any(tx.account_id == self.account_id for tx in view.pending):
            return ()

        best: tuple[int, Transaction, int, int] | None = None
        for victim in view.pending:
            market = view.state.markets[victim.market_id]
            asset_in = market.base_asset if victim.side is Side.SELL else market.quote_asset

            f = max_front_run(market, victim, view.state.balance_of(self.account_id, asset_in))
            if f == 0:
                continue

            m1, q1 = apply_swap(market, victim.side, f)
            if q1 < 1:
                continue
            m2, _ = apply_swap(m1, victim.side, victim.amount_in)
            _, back_out = apply_swap(m2, _opposite(victim.side), q1)
            profit = back_out - f
            if profit <= 0:
                continue

            value = profit * market.last_price // SCALE if victim.side is Side.SELL else profit
            if best is None or value > best[0]:
                best = (value, victim, f, q1)

        if best is None:
            return ()
        _, victim, f, q1 = best
        n = view.state.next_nonce(self.account_id)
        return (
            Order(
                self.account_id,
                n,
                victim.market_id,
                victim.side,
                f,
                0,
                victim.priority_fee + 1,
                victim.expires_at,
            ),
            Order(
                self.account_id,
                n + 1,
                victim.market_id,
                _opposite(victim.side),
                q1,
                0,
                victim.priority_fee,
                victim.expires_at,
            ),
        )
