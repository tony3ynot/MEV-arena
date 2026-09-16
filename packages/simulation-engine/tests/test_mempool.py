from dataclasses import replace

import pytest
from simulation_engine.mempool import Admission, Mempool
from simulation_engine.models import SCALE, Side, Transaction


def tx(
    id: str, account: str = "alice", nonce: int = 0, fee: int = 1, key: str | None = None
) -> Transaction:
    return Transaction(
        id=id,
        idempotency_key=key or f"key-{id}",
        account_id=account,
        nonce=nonce,
        market_id="eth-usdc",
        side=Side.SELL,
        amount_in=SCALE,
        min_amount_out=0,
        priority_fee=fee,
        submitted_at=0,
        expires_at=10,
    )


def test_accepts_and_indexes():
    pool = Mempool()
    assert pool.add(tx("a"), next_nonce=0) is Admission.ACCEPTED
    assert len(pool) == 1 and "a" in pool and pool.get("a") is not None
    assert pool.arrival_of("a") == 0


def test_arrival_is_strictly_increasing_and_never_reused():
    pool = Mempool()
    pool.add(tx("a"), 0)
    pool.add(tx("b", nonce=1), 0)
    pool.remove("a")
    pool.add(tx("c", nonce=2), 0)
    assert pool.arrival_of("b") == 1 and pool.arrival_of("c") == 2


def test_same_key_same_payload_is_idempotent():
    pool = Mempool()
    pool.add(tx("a"), 0)
    assert pool.add(tx("a"), 0) is Admission.DUPLICATE
    assert len(pool) == 1


def test_same_key_different_payload_conflicts():
    pool = Mempool()
    pool.add(tx("a"), 0)
    other = replace(tx("a"), amount_in=2 * SCALE)
    assert pool.add(other, 0) is Admission.CONFLICT
    assert pool.get("a") == tx("a")


def test_stale_nonce_rejected():
    pool = Mempool()
    assert pool.add(tx("a", nonce=3), next_nonce=4) is Admission.STALE_NONCE
    assert len(pool) == 0


def test_future_nonce_allowed():
    pool = Mempool()
    assert pool.add(tx("a", nonce=7), next_nonce=0) is Admission.ACCEPTED


def test_higher_fee_replaces_same_account_nonce():
    pool = Mempool()
    pool.add(tx("a", fee=1), 0)
    assert pool.add(tx("b", fee=2), 0) is Admission.REPLACED
    assert len(pool) == 1 and "a" not in pool and "b" in pool
    # the replaced transaction is gone from every index: its key can be reused, its slot is free
    assert pool.add(tx("c", fee=1, key="key-a"), 0) is Admission.UNDERPRICED
    assert pool.add(tx("d", fee=3, key="key-a"), 0) is Admission.REPLACED


@pytest.mark.parametrize("fee", [1, 0])
def test_equal_or_lower_fee_is_underpriced(fee: int):
    pool = Mempool()
    pool.add(tx("a", fee=1), 0)
    assert pool.add(tx("b", fee=fee), 0) is Admission.UNDERPRICED
    assert "a" in pool and "b" not in pool


def test_different_accounts_do_not_collide():
    pool = Mempool()
    pool.add(tx("a", account="alice"), 0)
    assert pool.add(tx("b", account="bob"), 0) is Admission.ACCEPTED
    assert len(pool) == 2


def test_remove_is_idempotent_and_clears_indexes():
    pool = Mempool()
    pool.add(tx("a"), 0)
    pool.remove("a")
    pool.remove("a")
    assert len(pool) == 0
    assert pool.add(tx("a"), 0) is Admission.ACCEPTED
