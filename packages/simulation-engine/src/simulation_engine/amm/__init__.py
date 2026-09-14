"""Constant-product AMM math (x * y = k).

Integer arithmetic only. Every division is an explicit floor in the protocol's favour,
so the invariant ``k`` never decreases across a swap.
"""

from dataclasses import replace

from simulation_engine.models import BPS, SCALE, MarketState, Side


def get_amount_out(amount_in: int, reserve_in: int, reserve_out: int, fee_bps: int) -> int:
    """Quote received for ``amount_in`` paid into a pool, Uniswap-v2 style (fee taken on input).

    in_after_fee = amount_in * (BPS - fee_bps)
    out = reserve_out * in_after_fee // (reserve_in * BPS + in_after_fee)
    Floor division rounds in the pool's favour.
    """
    if amount_in <= 0:
        raise ValueError("amount_in must be positive")
    if reserve_in <= 0 or reserve_out <= 0:
        raise ValueError("reserves must be positive")
    if not 0 <= fee_bps < BPS:
        raise ValueError("fee_bps must be in [0, BPS)")
    in_after_fee = amount_in * (BPS - fee_bps)
    return reserve_out * in_after_fee // (reserve_in * BPS + in_after_fee)


def fee_of(amount_in: int, fee_bps: int) -> int:
    """Part of ``amount_in`` kept by the pool as fee (floor)."""
    return amount_in * fee_bps // BPS


def apply_swap(market: MarketState, side: Side, amount_in: int) -> tuple[MarketState, int]:
    """Execute a swap against ``market`` and return ``(new_market, amount_out)``.

    ``market`` is not mutated. SELL pays base and receives quote; BUY pays quote and receives base.
    """
    if side is Side.SELL:
        amount_out = get_amount_out(
            amount_in, market.base_reserve, market.quote_reserve, market.fee_bps
        )
        base, quote = market.base_reserve + amount_in, market.quote_reserve - amount_out
    else:
        amount_out = get_amount_out(
            amount_in, market.quote_reserve, market.base_reserve, market.fee_bps
        )
        base, quote = market.base_reserve - amount_out, market.quote_reserve + amount_in
    new_market = replace(market, base_reserve=base, quote_reserve=quote, version=market.version + 1)
    return new_market, amount_out


def slippage_bps(amount_in: int, amount_out: int, spot_price: int, side: Side) -> int:
    """How much worse than the pre-trade spot price the fill was, in bps (floor, never negative).

    ``spot_price`` is quote per base with ``SCALE`` decimals, i.e. ``MarketState.last_price``.
    """
    if side is Side.SELL:
        expected_out = amount_in * spot_price // SCALE
    else:
        expected_out = amount_in * SCALE // spot_price
    if expected_out <= 0:
        return 0
    return max(0, (expected_out - amount_out) * BPS // expected_out)
