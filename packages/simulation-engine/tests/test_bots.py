"""Bots. The oracle is the engine itself: build and execute a block, then read the receipts.

max_front_run: the largest front-run a victim's min_amount_out still lets through.
SandwichBot: which victim it picks, what it submits, and whether a fee-ordered block pays it.
"""

import random
from dataclasses import replace

import pytest
from hypothesis import example, given
from hypothesis import strategies as st
from simulation_engine.amm import apply_swap, get_amount_out
from simulation_engine.block_builder import BuilderPolicy, build_block
from simulation_engine.bots import BotView, Order, SandwichBot, max_front_run
from simulation_engine.execution import WorldState, execute_block
from simulation_engine.models import (
    BPS,
    SCALE,
    AccountBalance,
    ErrorCode,
    ExecutionReceipt,
    MarketState,
    Side,
    Transaction,
    TransactionStatus,
)

MARKET = MarketState(
    "eth-usdc", 1_000 * SCALE, 1_000_000 * SCALE, fee_bps=30, base_asset="ETH", quote_asset="USDC"
)


def _tx(
    id: str,
    account: str,
    side: Side,
    amount_in: int,
    min_out: int = 0,
    *,
    nonce: int = 0,
    fee: int = 0,
) -> Transaction:
    return Transaction(
        id, f"idem-{id}", account, nonce, "eth-usdc", side, amount_in, min_out, fee, 0, 10
    )


def _victim(
    side: Side, amount_in: int, tolerance_bps: int, market: MarketState = MARKET
) -> Transaction:
    """A victim whose min_amount_out is its quote on ``market`` less ``tolerance_bps``."""
    if side is Side.SELL:
        reserve_in, reserve_out = market.base_reserve, market.quote_reserve
    else:
        reserve_in, reserve_out = market.quote_reserve, market.base_reserve
    quoted = get_amount_out(amount_in, reserve_in, reserve_out, market.fee_bps)
    return _tx("victim", "victim", side, amount_in, quoted * (BPS - tolerance_bps) // BPS)


def _victim_receipt(market: MarketState, victim: Transaction, front: int) -> ExecutionReceipt:
    """Execute [front-run of ``front``, victim]; ``front == 0`` means the victim alone."""
    plenty = 10**12 * SCALE
    world = WorldState(
        markets={market.market_id: market},
        balances={
            (account, asset): AccountBalance(account, asset, plenty)
            for account in ("bot", "victim")
            for asset in (market.base_asset, market.quote_asset)
        },
    )
    txs = [_tx("front", "bot", victim.side, front)] if front > 0 else []
    _, receipts = execute_block(world, [*txs, victim], 1)
    return receipts[-1]


def _fills(market: MarketState, victim: Transaction, front: int) -> bool:
    return _victim_receipt(market, victim, front).status is TransactionStatus.EXECUTED


def test_largest_front_run_leaves_the_victim_exactly_at_its_limit():
    victim = _victim(Side.SELL, 10 * SCALE, tolerance_bps=100)
    f = max_front_run(MARKET, victim, balance=1_000 * SCALE)

    assert 0 < f < 1_000 * SCALE
    assert _fills(MARKET, victim, f)
    one_more = _victim_receipt(MARKET, victim, f + 1)
    assert (one_more.status, one_more.error_code) == (TransactionStatus.FAILED, ErrorCode.SLIPPAGE)


def test_buy_side_mirrors_sell_side():
    victim = _victim(Side.BUY, 10_000 * SCALE, tolerance_bps=100)
    f = max_front_run(MARKET, victim, balance=1_000_000 * SCALE)

    assert 0 < f < 1_000_000 * SCALE
    assert _fills(MARKET, victim, f)
    assert not _fills(MARKET, victim, f + 1)


def test_victim_that_fails_alone_gets_no_front_run():
    exact = _victim(Side.SELL, 10 * SCALE, tolerance_bps=0)
    victim = replace(exact, min_amount_out=exact.min_amount_out + 1)
    assert not _fills(MARKET, victim, 0)

    assert max_front_run(MARKET, victim, balance=1_000 * SCALE) == 0


def test_front_run_never_exceeds_the_bots_balance():
    tolerant = _victim(Side.SELL, 10 * SCALE, tolerance_bps=BPS - 1)  # takes almost any price

    assert max_front_run(MARKET, tolerant, balance=50 * SCALE) == 50 * SCALE
    assert max_front_run(MARKET, tolerant, balance=0) == 0


@given(
    base=st.integers(SCALE, 10**6 * SCALE),
    quote=st.integers(SCALE, 10**6 * SCALE),
    fee_bps=st.integers(0, 100),
    side=st.sampled_from(Side),
    amount_in=st.integers(1, 10**4 * SCALE),
    tolerance_bps=st.integers(0, 1_000),
    balance=st.integers(0, 10**6 * SCALE),
)
# A 1-unit front-run fills zero, so the engine reverts it and the price never moves.
@example(
    base=SCALE, quote=SCALE, fee_bps=0, side=Side.BUY, amount_in=SCALE, tolerance_bps=0, balance=1
)
def test_result_is_the_boundary(
    base: int,
    quote: int,
    fee_bps: int,
    side: Side,
    amount_in: int,
    tolerance_bps: int,
    balance: int,
):
    """``f`` fills and ``f + 1`` does not, unless a bound (0 or the balance) stops it first."""
    market = replace(MARKET, base_reserve=base, quote_reserve=quote, fee_bps=fee_bps)
    victim = _victim(side, amount_in, tolerance_bps, market)
    f = max_front_run(market, victim, balance)

    assert 0 <= f <= balance
    assert f == 0 or _fills(market, victim, f)
    assert f == balance or not _fills(market, victim, f + 1)


# --- SandwichBot -------------------------------------------------------------------------------

BOT = SandwichBot("sandwich-0")
BOT_START = {"ETH": 100 * SCALE, "USDC": 100_000 * SCALE}
BOT_NONCE = 3


def _pending_victim(
    id: str, side: Side, amount_in: int, tolerance_bps: int = 100, fee: int = 50
) -> Transaction:
    """A noise trader's swap waiting in the mempool, quoted on MARKET."""
    v = _victim(side, amount_in, tolerance_bps)
    return replace(v, id=id, idempotency_key=f"idem-{id}", account_id=id, priority_fee=fee)


def _view(*pending: Transaction) -> BotView:
    balances = {
        (BOT.account_id, asset): AccountBalance(BOT.account_id, asset, amount)
        for asset, amount in BOT_START.items()
    }
    plenty = 10**9 * SCALE
    for tx in pending:
        if tx.account_id != BOT.account_id:
            for asset in BOT_START:
                balances[(tx.account_id, asset)] = AccountBalance(tx.account_id, asset, plenty)
    state = WorldState(
        markets={"eth-usdc": MARKET}, balances=balances, nonces={BOT.account_id: BOT_NONCE}
    )
    return BotView(height=1, state=state, pending=pending, reference_price=MARKET.last_price)


def _decide(*pending: Transaction) -> tuple[Order, ...]:
    return BOT.decide(_view(*pending), random.Random(0))


def test_nothing_pending_nothing_to_do():
    assert _decide() == ()


def test_skips_a_victim_too_small_to_pay_the_pool_fee():
    """2 ETH into a 1,000 ETH pool at 30 bps: every front-run size loses (v < fee x reserve)."""
    assert _decide(_pending_victim("small", Side.SELL, 2 * SCALE)) == ()


def test_sandwiches_a_profitable_victim():
    victim = _pending_victim("v", Side.SELL, 10 * SCALE)
    front, back = _decide(victim)
    f = max_front_run(MARKET, victim, BOT_START["ETH"])

    assert (front.account_id, front.nonce, front.side, front.amount_in) == (
        BOT.account_id,
        BOT_NONCE,
        Side.SELL,
        f,
    )
    assert (back.account_id, back.nonce, back.side) == (BOT.account_id, BOT_NONCE + 1, Side.BUY)
    assert back.amount_in == apply_swap(MARKET, Side.SELL, f)[1]  # all the front-run received
    assert front.market_id == back.market_id == victim.market_id
    assert front.expires_at == back.expires_at == victim.expires_at


def test_waits_while_its_own_transaction_is_pending():
    own = _tx("own", BOT.account_id, Side.SELL, SCALE, nonce=BOT_NONCE)
    assert _decide(own, _pending_victim("v", Side.SELL, 10 * SCALE)) == ()


def test_picks_the_most_profitable_victim():
    small = _pending_victim("small", Side.SELL, 5 * SCALE)
    large = _pending_victim("large", Side.SELL, 50 * SCALE)
    front, _ = _decide(small, large)

    assert front.amount_in == max_front_run(MARKET, large, BOT_START["ETH"])


def test_compares_victims_on_both_sides_in_quote():
    """≈ 0.07 ETH (≈ 70 USDC) from the seller beats ≈ 20 USDC from the buyer.

    In raw units the buyer's profit is the bigger integer, so this fails unless the
    seller's ETH profit is converted at the pool price first.
    """
    seller = _pending_victim("seller", Side.SELL, 10 * SCALE)
    buyer = _pending_victim("buyer", Side.BUY, 5_000 * SCALE)
    front, _ = _decide(buyer, seller)

    assert (front.side, front.amount_in) == (
        Side.SELL,
        max_front_run(MARKET, seller, BOT_START["ETH"]),
    )


@pytest.mark.parametrize(
    ("side", "amount_in", "profit_asset"),
    [(Side.SELL, 10 * SCALE, "ETH"), (Side.BUY, 10_000 * SCALE, "USDC")],
)
def test_priority_fee_builder_wraps_the_victim_and_the_bot_profits(
    side: Side, amount_in: int, profit_asset: str
):
    """End to end: orders → transactions → PRIORITY_FEE block → execution → bot balance."""
    bystander = _tx("by", "noise-1", Side.SELL, SCALE // 10, fee=49)  # pays a little less
    victim = _pending_victim("v", side, amount_in, fee=50)
    view = _view(bystander, victim)
    orders = BOT.decide(view, random.Random(0))
    assert len(orders) == 2

    submitted = [o.to_transaction(f"bot-{i}", f"idem-bot-{i}", 1) for i, o in enumerate(orders)]
    block = build_block(
        [*view.pending, *submitted],
        view.state.next_nonce,
        policy=BuilderPolicy.PRIORITY_FEE,
        capacity=10,
        seed=0,
    )
    ids = [tx.id for tx in block]
    assert ids.index("bot-0") < ids.index("v") < ids.index("bot-1")

    after, receipts = execute_block(view.state, block, 1)
    assert all(r.status is TransactionStatus.EXECUTED for r in receipts)
    assert after.balance_of(BOT.account_id, profit_asset) > BOT_START[profit_asset]
