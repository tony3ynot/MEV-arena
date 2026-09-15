"""Week-2 question: does transaction order alone change what an AMM executes?

Same three transactions, two orders. The victim's fill and the bot's P&L are read off receipts.
"""

from simulation_engine.events import (
    BlockCommitted,
    MarketPriceUpdated,
    SwapExecuted,
    TransactionExecuted,
    events_for_block,
)
from simulation_engine.execution import WorldState, execute_block, state_hash
from simulation_engine.models import SCALE, AccountBalance, MarketState, Side, Transaction

MARKET = MarketState(
    "eth-usdc", 1_000 * SCALE, 1_000_000 * SCALE, fee_bps=30, base_asset="ETH", quote_asset="USDC"
)


def _tx(id: str, account: str, nonce: int, side: Side, amount_in: int) -> Transaction:
    return Transaction(id, f"idem-{id}", account, nonce, "eth-usdc", side, amount_in, 0, 0, 0, 10)


def _world() -> WorldState:
    return WorldState(
        markets={"eth-usdc": MARKET},
        balances={
            ("victim", "ETH"): AccountBalance("victim", "ETH", 10 * SCALE),
            ("bot", "ETH"): AccountBalance("bot", "ETH", 100 * SCALE),
        },
    )


VICTIM_SELL = _tx("victim", "victim", 0, Side.SELL, 10 * SCALE)
BOT_FRONT = _tx("front", "bot", 0, Side.SELL, 100 * SCALE)


def test_victim_alone_gets_the_prediction_table_value():
    _, (r,) = execute_block(_world(), [VICTIM_SELL], 1)
    assert r.amount_out // SCALE == 9_871


def test_sandwich_moves_value_from_victim_to_bot():
    """One block: bot sells 100 ETH, victim sells 10, bot buys back with every USDC it got."""
    s0 = _world()
    _, (probe,) = execute_block(s0, [BOT_FRONT], 1)  # dry run to size the back-run
    back = _tx("back", "bot", 1, Side.BUY, probe.amount_out)
    s1, (front, victim, r_back) = execute_block(s0, [BOT_FRONT, VICTIM_SELL, back], 1)

    victim_alone = 9_871
    victim_sandwiched = victim.amount_out // SCALE
    bot_eth_after = s1.balance_of("bot", "ETH")
    assert victim_sandwiched < victim_alone
    assert bot_eth_after > 100 * SCALE  # bot ends with more ETH than it started with
    assert s1.balance_of("bot", "USDC") == 0

    # numbers for the learning note (pytest -s)
    worse_bps = (victim_alone - victim_sandwiched) * 10_000 // victim_alone
    profit_eth = (bot_eth_after - 100 * SCALE) / SCALE
    print(
        f"\nvictim alone {victim_alone} / sandwiched {victim_sandwiched} USDC "
        f"({worse_bps} bps worse)"
        f"\nbot: sold 100 ETH for {front.amount_out // SCALE} USDC, "
        f"bought back {r_back.amount_out / SCALE:.3f} ETH -> profit {profit_eth:.3f} ETH"
        f"\nspot after block {s1.markets['eth-usdc'].last_price // SCALE}"
    )


def test_order_changes_hash_and_victim_fill():
    s0 = _world()
    front_first, (_, victim_after) = execute_block(s0, [BOT_FRONT, VICTIM_SELL], 1)
    victim_first, (victim_before, _) = execute_block(s0, [VICTIM_SELL, BOT_FRONT], 1)
    assert state_hash(front_first) != state_hash(victim_first)
    assert victim_after.amount_out < victim_before.amount_out
    # yet the pool ends with the same reserves either way? No: floor rounding and fee on each
    # leg make the path matter, so even the *pool* differs. Check both differ, not just users.
    assert front_first.markets != victim_first.markets


def test_events_for_block_shapes():
    s0 = _world()
    txs = [BOT_FRONT, VICTIM_SELL]
    s1, receipts = execute_block(s0, txs, 1)
    events = events_for_block(txs, receipts, s1, 1, state_hash(s1))
    kinds = [type(e).__name__ for e in events]
    assert kinds == [
        "TransactionExecuted",
        "SwapExecuted",
        "TransactionExecuted",
        "SwapExecuted",
        "MarketPriceUpdated",
        "BlockCommitted",
    ]
    assert isinstance(events[-1], BlockCommitted) and events[-1].executed == 2
    assert isinstance(events[-2], MarketPriceUpdated) and events[-2].version == 2
    assert isinstance(events[1], SwapExecuted) and events[1].account_id == "bot"
    assert isinstance(events[0], TransactionExecuted) and events[0].position == 0
