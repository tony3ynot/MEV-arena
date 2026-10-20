from collections.abc import Callable

import pytest
from hypothesis import given
from hypothesis import strategies as st
from simulation_engine.block_builder import BuilderPolicy, build_block
from simulation_engine.execution import WorldState, execute_block
from simulation_engine.models import (
    SCALE,
    AccountBalance,
    MarketState,
    Side,
    Transaction,
    TransactionStatus,
)


def tx(id: str, account: str, nonce: int, fee: int = 0) -> Transaction:
    return Transaction(id, f"key-{id}", account, nonce, "eth-usdc", Side.SELL, SCALE, 0, fee, 0, 10)


def ids(block: tuple[Transaction, ...]) -> list[str]:
    return [t.id for t in block]


def fresh(_account: str) -> int:
    return 0


def build(
    candidates: tuple[Transaction, ...],
    policy: BuilderPolicy = BuilderPolicy.PRIORITY_FEE,
    capacity: int = 10,
    seed: int = 0,
    next_nonce: Callable[[str], int] = fresh,
) -> tuple[Transaction, ...]:
    return build_block(candidates, next_nonce, policy=policy, capacity=capacity, seed=seed)


# x, y, z: a higher fee on alice's second transaction must not let it jump her first.
XYZ = (tx("x", "alice", 0, fee=1), tx("y", "alice", 1, fee=5), tx("z", "bob", 0, fee=3))


def test_priority_fee_keeps_each_accounts_nonce_order():
    assert ids(build(XYZ)) == ["z", "x", "y"]


def test_the_built_block_executes_without_a_bad_nonce():
    market = MarketState(
        "eth-usdc", 1_000 * SCALE, 1_000_000 * SCALE, 30, base_asset="ETH", quote_asset="USDC"
    )
    state = WorldState(
        markets={"eth-usdc": market},
        balances={(who, "ETH"): AccountBalance(who, "ETH", 10 * SCALE) for who in ("alice", "bob")},
    )
    _, receipts = execute_block(state, build(XYZ), block_height=1)
    assert [r.status for r in receipts] == [TransactionStatus.EXECUTED] * 3


def test_fifo_follows_arrival():
    assert ids(build(XYZ, BuilderPolicy.FIFO)) == ["x", "y", "z"]


def test_capacity_caps_the_block_and_the_rest_waits():
    assert ids(build(XYZ, capacity=2)) == ["z", "x"]
    assert build(XYZ, capacity=0) == ()
    with pytest.raises(ValueError):
        build(XYZ, capacity=-1)


def test_a_nonce_gap_waits_for_the_missing_transaction():
    assert build((tx("y", "alice", 1),)) == ()


def test_a_used_nonce_is_skipped():
    block = build((tx("old", "alice", 0), tx("new", "alice", 1)), next_nonce=lambda _: 1)
    assert ids(block) == ["new"]


def test_random_is_reproducible_from_the_seed():
    pool = tuple(tx(f"t{i}", f"acct{i}", 0) for i in range(6))
    assert build(pool, BuilderPolicy.RANDOM, seed=7) == build(pool, BuilderPolicy.RANDOM, seed=7)
    orders = {tuple(ids(build(pool, BuilderPolicy.RANDOM, seed=s))) for s in range(10)}
    assert len(orders) > 1


ACCOUNTS = ["alice", "bob", "carol"]


@st.composite
def pools(draw: st.DrawFn) -> tuple[tuple[Transaction, ...], dict[str, int]]:
    """A candidate set as the mempool would hand it over: one transaction per (account, nonce),
    in arrival order, plus each account's next nonce."""
    slots = draw(
        st.lists(st.tuples(st.sampled_from(ACCOUNTS), st.integers(0, 4)), unique=True, max_size=12)
    )
    fees = draw(st.lists(st.integers(0, 3), min_size=len(slots), max_size=len(slots)))
    candidates = tuple(
        tx(f"t{i}", a, n, f) for i, ((a, n), f) in enumerate(zip(slots, fees, strict=True))
    )
    nonces = draw(st.fixed_dictionaries({a: st.integers(0, 2) for a in ACCOUNTS}))
    return candidates, nonces


@given(
    pool=pools(),
    policy=st.sampled_from(BuilderPolicy),
    capacity=st.integers(0, 8),
    seed=st.integers(0, 2**32),
)
def test_any_block_is_executable_bounded_and_reproducible(
    pool: tuple[tuple[Transaction, ...], dict[str, int]],
    policy: BuilderPolicy,
    capacity: int,
    seed: int,
):
    candidates, nonces = pool
    block = build(candidates, policy, capacity, seed, nonces.__getitem__)

    assert block == build(candidates, policy, capacity, seed, nonces.__getitem__)
    assert len(block) <= capacity and len(set(ids(block))) == len(block)
    assert set(block) <= set(candidates)

    expected = dict(nonces)
    for t in block:  # in this order, every transaction meets its account's next nonce
        assert t.nonce == expected[t.account_id]
        expected[t.account_id] += 1

    if len(block) < capacity:  # room was left, so nothing executable may have been left behind
        assert not [t for t in candidates if t not in block and t.nonce == expected[t.account_id]]


@given(pool=pools(), capacity=st.integers(0, 8))
def test_each_pick_is_the_best_head_that_could_execute(
    pool: tuple[tuple[Transaction, ...], dict[str, int]], capacity: int
):
    candidates, nonces = pool
    arrival = {t.id: i for i, t in enumerate(candidates)}
    preference: dict[BuilderPolicy, Callable[[Transaction], tuple[int, ...]]] = {
        BuilderPolicy.FIFO: lambda t: (arrival[t.id],),
        BuilderPolicy.PRIORITY_FEE: lambda t: (-t.priority_fee, arrival[t.id]),
    }
    for policy, key in preference.items():
        block = build(candidates, policy, capacity, 0, nonces.__getitem__)
        expected = dict(nonces)
        for picked_so_far, t in enumerate(block):
            ready = [
                c
                for c in candidates
                if c not in block[:picked_so_far] and c.nonce == expected[c.account_id]
            ]
            assert key(t) == min(map(key, ready))
            expected[t.account_id] += 1
