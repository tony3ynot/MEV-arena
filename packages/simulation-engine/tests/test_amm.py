from hypothesis import given, settings
from hypothesis import strategies as st
from simulation_engine.amm import apply_swap, get_amount_out, slippage_bps
from simulation_engine.models import SCALE, MarketState, Side

# --- worked examples from the week-2 prediction table ---------------------------------------

ETH_USDC = MarketState(
    "eth-usdc", base_reserve=1_000 * SCALE, quote_reserve=1_000_000 * SCALE, fee_bps=30
)


def test_prediction_table():
    """Sell 1 / 10 / 100 base into a 1000 x 1_000_000 pool at 30 bps."""
    # Hand calculation said 40 / 128 / 934 bps; the exact values floor to 39 / 128 / 933.
    rows = {1: (996, 39), 10: (9_871, 128), 100: (90_661, 933)}
    for whole, (expected_out, expected_slip) in rows.items():
        market, out = apply_swap(ETH_USDC, Side.SELL, whole * SCALE)
        assert out // SCALE == expected_out
        assert slippage_bps(whole * SCALE, out, ETH_USDC.last_price, Side.SELL) == expected_slip
        assert market.version == 1


def test_spot_price_is_fixed_point():
    assert ETH_USDC.last_price == 1_000 * SCALE


# --- invariants -------------------------------------------------------------------------------

amounts = st.integers(min_value=1, max_value=10**30)
reserves = st.integers(min_value=1, max_value=10**30)
fees = st.integers(min_value=0, max_value=9_999)


@given(amount_in=amounts, reserve_in=reserves, reserve_out=reserves, fee_bps=fees)
@settings(max_examples=500)
def test_k_never_decreases(amount_in: int, reserve_in: int, reserve_out: int, fee_bps: int):
    out = get_amount_out(amount_in, reserve_in, reserve_out, fee_bps)
    assert 0 <= out < reserve_out
    assert (reserve_in + amount_in) * (reserve_out - out) >= reserve_in * reserve_out


@given(amount_in=amounts, base=reserves, quote=reserves, fee_bps=fees, side=st.sampled_from(Side))
@settings(max_examples=500)
def test_apply_swap_is_pure_and_keeps_reserves_positive(
    amount_in: int, base: int, quote: int, fee_bps: int, side: Side
):
    before = MarketState("m", base, quote, fee_bps)
    after, out = apply_swap(before, side, amount_in)
    assert before == MarketState("m", base, quote, fee_bps)  # not mutated
    assert after.base_reserve > 0 and after.quote_reserve > 0
    assert after.k >= before.k
    assert after.version == before.version + 1
    assert slippage_bps(amount_in, out, before.last_price, side) >= 0 if before.last_price else True


@given(a=amounts, b=amounts, base=reserves, quote=reserves, fee_bps=fees)
@settings(max_examples=300)
def test_splitting_a_trade_never_beats_one_trade(
    a: int, b: int, base: int, quote: int, fee_bps: int
):
    """Two smaller sells never receive more than one combined sell (convexity + floor)."""
    m = MarketState("m", base, quote, fee_bps)
    _, whole = apply_swap(m, Side.SELL, a + b)
    m1, out_a = apply_swap(m, Side.SELL, a)
    _, out_b = apply_swap(m1, Side.SELL, b)
    assert out_a + out_b <= whole + 1  # +1: independent floors can round 1 unit apart
