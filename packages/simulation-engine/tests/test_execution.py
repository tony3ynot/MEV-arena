from hypothesis import given, settings
from hypothesis import strategies as st
from simulation_engine.execution import WorldState, execute_block, state_hash
from simulation_engine.models import (
    SCALE,
    AccountBalance,
    ErrorCode,
    MarketState,
    Side,
    Transaction,
    TransactionStatus,
)

MARKET = MarketState(
    "eth-usdc", 1_000 * SCALE, 1_000_000 * SCALE, fee_bps=30, base_asset="ETH", quote_asset="USDC"
)


def tx(
    id: str,
    account: str,
    nonce: int,
    side: Side,
    amount_in: int,
    min_out: int = 0,
    fee: int = 0,
) -> Transaction:
    return Transaction(
        id, f"idem-{id}", account, nonce, "eth-usdc", side, amount_in, min_out, fee, 0, 10
    )


def world(**eth_and_usdc: tuple[int, int]) -> WorldState:
    balances: dict[tuple[str, str], AccountBalance] = {}
    for acct, (eth, usdc) in eth_and_usdc.items():
        balances[(acct, "ETH")] = AccountBalance(acct, "ETH", eth * SCALE)
        balances[(acct, "USDC")] = AccountBalance(acct, "USDC", usdc * SCALE)
    return WorldState(markets={"eth-usdc": MARKET}, balances=balances)


def test_sell_moves_balances_and_reserves():
    s0 = world(alice=(10, 0))
    s1, (r,) = execute_block(s0, [tx("t1", "alice", 0, Side.SELL, 1 * SCALE)], block_height=1)
    assert r.status is TransactionStatus.EXECUTED
    assert r.amount_out // SCALE == 996
    assert s1.balance_of("alice", "ETH") == 9 * SCALE
    assert s1.balance_of("alice", "USDC") == r.amount_out
    assert s1.markets["eth-usdc"].base_reserve == 1_001 * SCALE
    assert s1.next_nonce("alice") == 1
    assert s0.balance_of("alice", "ETH") == 10 * SCALE  # input untouched


def test_failed_tx_consumes_nonce_but_changes_nothing_else():
    s0 = world(alice=(1, 0))
    s1, (r,) = execute_block(s0, [tx("t1", "alice", 0, Side.SELL, 5 * SCALE)], block_height=1)
    assert r.status is TransactionStatus.FAILED
    assert r.error_code is ErrorCode.INSUFFICIENT_BALANCE
    assert s1.next_nonce("alice") == 1
    assert s1.balances == s0.balances and s1.markets == s0.markets


def test_bad_nonce_does_not_consume_nonce():
    s0 = world(alice=(1, 0))
    s1, (r,) = execute_block(s0, [tx("t1", "alice", 5, Side.SELL, SCALE)], block_height=1)
    assert r.error_code is ErrorCode.BAD_NONCE
    assert s1 == s0


def test_slippage_guard():
    s0 = world(alice=(1, 0))
    s1, (r,) = execute_block(
        s0, [tx("t1", "alice", 0, Side.SELL, SCALE, min_out=997 * SCALE)], block_height=1
    )
    assert r.error_code is ErrorCode.SLIPPAGE
    assert s1.markets == s0.markets


def test_same_nonce_exactly_one_succeeds():
    s0 = world(alice=(10, 0))
    a, b = tx("a", "alice", 0, Side.SELL, SCALE), tx("b", "alice", 0, Side.SELL, SCALE)
    _, receipts = execute_block(s0, [a, b], block_height=1)
    statuses = sorted(r.status for r in receipts)
    assert statuses == [TransactionStatus.EXECUTED, TransactionStatus.FAILED]


def test_replay_is_deterministic_and_order_matters():
    s0 = world(alice=(10, 0), bob=(0, 20_000))
    txs = [tx("a", "alice", 0, Side.SELL, SCALE), tx("b", "bob", 0, Side.BUY, 10_000 * SCALE)]
    s1, _ = execute_block(s0, txs, 1)
    s1_again, _ = execute_block(s0, txs, 1)
    s2, _ = execute_block(s0, txs[::-1], 1)
    assert state_hash(s1) == state_hash(s1_again)
    assert state_hash(s1) != state_hash(s2)
    assert state_hash(s1) != state_hash(s0)


# --- invariant: no asset is created or destroyed ---------------------------------------------

accounts = ["alice", "bob", "carol"]


def _random_tx(i: int, acct: str, nonce: int, side: Side, amount: int, min_out: int) -> Transaction:
    return tx(f"t{i}", acct, nonce, side, amount, min_out)


tx_specs = st.tuples(
    st.sampled_from(accounts),
    st.integers(0, 3),
    st.sampled_from(Side),
    st.integers(1, 50 * SCALE),
    st.integers(0, 2_000 * SCALE),
)


def _total(state: WorldState, asset: str) -> int:
    reserve = sum(
        (m.base_reserve if m.base_asset == asset else m.quote_reserve)
        for m in state.markets.values()
    )
    return reserve + sum(b.available_amount for b in state.balances.values() if b.asset == asset)


@given(st.lists(tx_specs, max_size=20))
@settings(max_examples=200)
def test_assets_are_conserved(specs: list[tuple[str, int, Side, int, int]]):
    s0 = world(alice=(10, 10_000), bob=(10, 10_000), carol=(10, 10_000))
    txs = [_random_tx(i, *spec) for i, spec in enumerate(specs)]
    s1, receipts = execute_block(s0, txs, block_height=1)
    assert len(receipts) == len(txs)
    for asset in ("ETH", "USDC"):
        assert _total(s1, asset) == _total(s0, asset)
    for m in s1.markets.values():
        assert m.k >= MARKET.k
