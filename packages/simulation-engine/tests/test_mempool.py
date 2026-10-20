from dataclasses import replace

import pytest
from hypothesis import strategies as st
from hypothesis.stateful import (
    RuleBasedStateMachine,
    invariant,
    rule,
    run_state_machine_as_test,  # pyright: ignore[reportUnknownVariableType]
)
from simulation_engine.mempool import Admission, AdmissionResult, Mempool
from simulation_engine.models import SCALE, Side, Transaction


def tx(
    id: str,
    account: str = "alice",
    nonce: int = 0,
    fee: int = 1,
    key: str | None = None,
    expires: int = 10,
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
        expires_at=expires,
    )


def test_accepts_and_indexes():
    pool = Mempool()
    assert pool.add(tx("a"), next_nonce=0, height=0).verdict is Admission.ACCEPTED
    assert len(pool) == 1 and "a" in pool and pool.get("a") is not None
    assert pool.arrival_of("a") == 0


def test_arrival_is_strictly_increasing_and_never_reused():
    pool = Mempool()
    pool.add(tx("a"), 0, height=0)
    pool.add(tx("b", nonce=1), 0, height=0)
    pool.remove("a")
    pool.add(tx("c", nonce=2), 0, height=0)
    assert pool.arrival_of("b") == 1 and pool.arrival_of("c") == 2


def test_same_key_same_payload_is_idempotent():
    pool = Mempool()
    pool.add(tx("a"), 0, height=0)
    assert pool.add(tx("a"), 0, height=0).verdict is Admission.DUPLICATE
    assert len(pool) == 1


def test_same_key_different_payload_conflicts():
    pool = Mempool()
    pool.add(tx("a"), 0, height=0)
    other = replace(tx("a"), amount_in=2 * SCALE)
    assert pool.add(other, 0, height=0).verdict is Admission.CONFLICT
    assert pool.get("a") == tx("a")


def test_stale_nonce_rejected():
    pool = Mempool()
    assert pool.add(tx("a", nonce=3), next_nonce=4, height=0).verdict is Admission.STALE_NONCE
    assert len(pool) == 0


def test_future_nonce_allowed():
    pool = Mempool()
    assert pool.add(tx("a", nonce=7), next_nonce=0, height=0).verdict is Admission.ACCEPTED


def test_higher_fee_replaces_same_account_nonce():
    pool = Mempool()
    pool.add(tx("a", fee=1), 0, height=0)
    assert pool.add(tx("b", fee=2), 0, height=0) == AdmissionResult(Admission.REPLACED, evicted="a")
    assert len(pool) == 1 and "a" not in pool and "b" in pool
    # the replaced transaction is gone from every index: its key can be reused, its slot is free
    assert pool.add(tx("c", fee=1, key="key-a"), 0, height=0).verdict is Admission.UNDERPRICED
    assert pool.add(tx("d", fee=3, key="key-a"), 0, height=0).verdict is Admission.REPLACED


@pytest.mark.parametrize("fee", [1, 0])
def test_equal_or_lower_fee_is_underpriced(fee: int):
    pool = Mempool()
    pool.add(tx("a", fee=1), 0, height=0)
    assert pool.add(tx("b", fee=fee), 0, height=0).verdict is Admission.UNDERPRICED
    assert "a" in pool and "b" not in pool


def test_different_accounts_do_not_collide():
    pool = Mempool()
    pool.add(tx("a", account="alice"), 0, height=0)
    assert pool.add(tx("b", account="bob"), 0, height=0).verdict is Admission.ACCEPTED
    assert len(pool) == 2


def test_remove_is_idempotent_and_clears_indexes():
    pool = Mempool()
    pool.add(tx("a"), 0, height=0)
    pool.remove("a")
    pool.remove("a")
    assert len(pool) == 0
    assert pool.add(tx("a"), 0, height=0).verdict is Admission.ACCEPTED


def test_reused_id_under_another_key_raises():
    pool = Mempool()
    pool.add(tx("a", nonce=0, key="k1"), 0, height=0)
    with pytest.raises(ValueError):
        pool.add(tx("a", nonce=1, key="k2"), 0, height=0)
    assert len(pool) == 1 and pool.get("a") == tx("a", nonce=0, key="k1")


def test_max_size_must_be_positive():
    with pytest.raises(ValueError):
        Mempool(max_size=0)


def full_pool() -> Mempool:
    pool = Mempool(max_size=2)
    pool.add(tx("a", nonce=0, fee=1), 0, height=0)
    pool.add(tx("b", nonce=1, fee=3), 0, height=0)
    return pool


def test_full_pool_evicts_the_cheapest():
    pool = full_pool()
    assert pool.add(tx("c", nonce=2, fee=2), 0, height=0) == AdmissionResult(
        Admission.ACCEPTED, evicted="a"
    )
    assert len(pool) == 2 and "a" not in pool and "c" in pool


@pytest.mark.parametrize("fee", [1, 0])
def test_full_pool_rejects_a_fee_that_does_not_beat_the_cheapest(fee: int):
    pool = full_pool()
    assert pool.add(tx("c", nonce=2, fee=fee), 0, height=0) == AdmissionResult(Admission.POOL_FULL)
    assert len(pool) == 2 and "a" in pool and "c" not in pool


def test_full_pool_on_a_fee_tie_evicts_the_latest_arrival():
    pool = Mempool(max_size=2)
    pool.add(tx("a", nonce=0, fee=1), 0, height=0)
    pool.add(tx("b", nonce=1, fee=1), 0, height=0)
    assert pool.add(tx("c", nonce=2, fee=2), 0, height=0).evicted == "b"


def test_replacement_needs_no_room():
    pool = Mempool(max_size=1)
    pool.add(tx("a", fee=1), 0, height=0)
    assert pool.add(tx("b", fee=2), 0, height=0) == AdmissionResult(Admission.REPLACED, evicted="a")


def test_valid_through_expires_at():
    pool = Mempool()
    assert pool.add(tx("a", expires=5), 0, height=5).verdict is Admission.ACCEPTED
    assert pool.add(tx("b", nonce=1, expires=4), 0, height=5).verdict is Admission.EXPIRED
    assert len(pool) == 1


def test_expired_newcomer_cannot_evict():
    pool = full_pool()
    result = pool.add(tx("c", nonce=2, fee=9, expires=0), 0, height=1)
    assert result == AdmissionResult(Admission.EXPIRED)
    assert len(pool) == 2 and "a" in pool


def test_expire_drops_and_reports_in_arrival_order():
    pool = Mempool()
    pool.add(tx("b", nonce=0, expires=3), 0, height=0)
    pool.add(tx("a", nonce=1, expires=3), 0, height=0)
    pool.add(tx("c", nonce=2, expires=9), 0, height=0)
    assert pool.expire(3) == ()
    assert pool.expire(4) == ("b", "a")
    assert [t.id for t in pool.candidates()] == ["c"]


def test_candidates_follow_arrival_and_a_replacement_goes_last():
    pool = Mempool()
    pool.add(tx("c", nonce=0), 0, height=0)
    pool.add(tx("a", nonce=1), 0, height=0)
    pool.add(tx("b", nonce=0, fee=2), 0, height=0)  # replaces c, gets a fresh arrival
    assert [t.id for t in pool.candidates()] == ["a", "b"]
    assert isinstance(pool.candidates(), tuple)


# Small pools so random draws collide often: shared keys, shared (account, nonce) slots, shared ids.
IDS = [f"t{i}" for i in range(6)]
transactions = st.builds(
    tx,
    id=st.sampled_from(IDS),
    account=st.sampled_from(["alice", "bob"]),
    nonce=st.integers(0, 2),
    fee=st.integers(0, 2),
    key=st.sampled_from([f"k{i}" for i in range(8)]),
)


class MempoolMachine(RuleBasedStateMachine):
    """Random add/remove sequences. Every verdict must match what visibly changed in the pool."""

    def __init__(self) -> None:
        super().__init__()
        self.pool = Mempool(max_size=3)
        self.last_arrival = -1
        self.height = 0

    def live(self) -> dict[str, Transaction]:
        return {i: t for i in IDS if (t := self.pool.get(i)) is not None}

    @rule(t=transactions, next_nonce=st.integers(0, 2), ttl=st.integers(-1, 3))
    def add(self, t: Transaction, next_nonce: int, ttl: int) -> None:
        t = replace(t, expires_at=self.height + ttl)  # ttl -1: already expired on arrival
        before = self.live()
        arrivals = {i: self.pool.arrival_of(i) for i in before}
        same_key = [o for o in before.values() if o.idempotency_key == t.idempotency_key]
        same_slot = [
            o for o in before.values() if (o.account_id, o.nonce) == (t.account_id, t.nonce)
        ]
        full = len(before) == self.pool.max_size

        if not same_key and t.id in before:  # id clash is a caller bug (ADR-0008)
            with pytest.raises(ValueError):
                self.pool.add(t, next_nonce, height=self.height)
            assert self.live() == before
            return

        result = self.pool.add(t, next_nonce, height=self.height)
        after = self.live()

        if result.verdict in (Admission.ACCEPTED, Admission.REPLACED):
            kept = {i: o for i, o in before.items() if i != result.evicted}
            assert t.id not in kept and after == kept | {t.id: t}
            assert not t.is_expired(self.height)
            assert self.pool.arrival_of(t.id) > self.last_arrival
            self.last_arrival = self.pool.arrival_of(t.id)
            if result.verdict is Admission.REPLACED:
                assert result.evicted == same_slot[0].id
            elif result.evicted is None:
                assert not full
            else:  # full pool: lowest fee goes, latest arrival first on a tie (ADR-0009)
                lowest = min(o.priority_fee for o in before.values())
                tied = [i for i, o in before.items() if o.priority_fee == lowest]
                assert full and t.priority_fee > lowest
                assert result.evicted == max(tied, key=lambda i: arrivals[i])
            return

        assert result.evicted is None and after == before  # every rejection leaves the pool alone
        if result.verdict is Admission.DUPLICATE:
            assert same_key == [t]
        elif result.verdict is Admission.CONFLICT:
            assert len(same_key) == 1 and same_key[0] != t
        elif result.verdict is Admission.UNDERPRICED:
            assert len(same_slot) == 1 and same_slot[0].priority_fee >= t.priority_fee
        elif result.verdict is Admission.EXPIRED:
            assert t.is_expired(self.height)
        elif result.verdict is Admission.POOL_FULL:
            assert full and not same_slot
            assert min(o.priority_fee for o in before.values()) >= t.priority_fee
        else:
            assert result.verdict is Admission.STALE_NONCE and t.nonce < next_nonce

    @rule(tx_id=st.sampled_from(IDS))
    def remove(self, tx_id: str) -> None:
        before = self.live()
        self.pool.remove(tx_id)
        assert self.live() == {i: t for i, t in before.items() if i != tx_id}

    @rule(blocks=st.integers(1, 2))
    def next_block(self, blocks: int) -> None:
        self.height += blocks
        before = self.live()
        doomed = [t.id for t in self.pool.candidates() if t.is_expired(self.height)]
        assert self.pool.expire(self.height) == tuple(doomed)
        assert self.live() == {i: t for i, t in before.items() if i not in doomed}

    @invariant()
    def candidates_in_arrival_order(self) -> None:
        arrivals = [self.pool.arrival_of(t.id) for t in self.pool.candidates()]
        assert arrivals == sorted(arrivals) and len(arrivals) == len(self.pool)

    @invariant()
    def one_per_key_and_per_slot(self) -> None:
        live = self.live()
        assert len(self.pool) == len(live) <= self.pool.max_size
        assert len({t.idempotency_key for t in live.values()}) == len(live)
        assert len({(t.account_id, t.nonce) for t in live.values()}) == len(live)


def test_verdicts_match_visible_changes():
    run_state_machine_as_test(MempoolMachine)
