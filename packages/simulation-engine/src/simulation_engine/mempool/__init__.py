"""Mempool rules.

De-duplication, nonce validation, bounded queue, expiry by block clock, and an immutable
candidate set for the block builder.

The pool is a mutable object, but a deterministic one: no wall clock, no global random, no I/O.
Two pools fed the same sequence of calls end in the same state.
"""

from dataclasses import dataclass, field
from enum import StrEnum

from simulation_engine.models import Transaction


class Admission(StrEnum):
    ACCEPTED = "accepted"
    """New transaction stored. If the pool was full, it pushed out the cheapest one (ADR-0009)."""
    REPLACED = "replaced"
    """Stored; it evicted an earlier transaction with the same (account, nonce) and a lower fee."""
    DUPLICATE = "duplicate"
    """Same idempotency_key and same payload as one already stored. Not an error (idempotent)."""
    CONFLICT = "conflict"
    """Same idempotency_key, different payload. Rejected."""
    UNDERPRICED = "underpriced"
    """Same (account, nonce) as a stored transaction, fee not strictly higher. Rejected."""
    STALE_NONCE = "stale_nonce"
    """nonce below the account's next expected nonce. Rejected."""
    EXPIRED = "expired"
    """Already expired at the current block height. Rejected before it can evict (ADR-0010)."""
    POOL_FULL = "pool_full"
    """Pool at max_size and the fee does not beat the cheapest stored transaction. Rejected."""


@dataclass(frozen=True, slots=True)
class AdmissionResult:
    verdict: Admission
    evicted: str | None = None
    """Id of the transaction this admission pushed out: the one it REPLACED, or the cheapest one
    when the pool was full. The caller reports it to its owner."""


@dataclass
class Mempool:
    """Pending transactions, keyed for the three lookups admission needs.

    Per block, the caller runs ``expire(height)``, then hands ``candidates()`` to the block builder.

    Invariants (tests check them):
    - one transaction per idempotency_key
    - one transaction per (account_id, nonce)
    - ``arrival`` is a strictly increasing sequence number, never reused
    - at most ``max_size`` transactions
    """

    max_size: int = 10_000
    """Placeholder until the week-3 backpressure experiment gives a measured figure."""
    _by_id: dict[str, Transaction] = field(default_factory=dict[str, Transaction])
    _by_idempotency_key: dict[str, str] = field(default_factory=dict[str, str])
    """idempotency_key -> transaction id"""
    _by_account_nonce: dict[tuple[str, int], str] = field(
        default_factory=dict[tuple[str, int], str]
    )
    """(account_id, nonce) -> transaction id"""
    _arrival: dict[str, int] = field(default_factory=dict[str, int])
    """transaction id -> arrival sequence number"""
    _next_arrival: int = 0

    def __post_init__(self) -> None:
        if self.max_size < 1:
            raise ValueError(f"max_size must be at least 1, got {self.max_size}")

    def __len__(self) -> int:
        return len(self._by_id)

    def __contains__(self, tx_id: str) -> bool:
        return tx_id in self._by_id

    def get(self, tx_id: str) -> Transaction | None:
        return self._by_id.get(tx_id)

    def arrival_of(self, tx_id: str) -> int:
        return self._arrival[tx_id]

    def add(self, tx: Transaction, next_nonce: int, *, height: int) -> AdmissionResult:
        """Admit ``tx`` or say why not.

        ``next_nonce`` is the account's next expected nonce, read from world state by the caller.
        ``height`` is the block being built; a transaction already expired there is turned away.
        Check order: idempotency_key -> expiry -> nonce -> (account, nonce) replacement ->
        capacity. Stop at the first verdict. On REPLACED, the old transaction must disappear from
        *every* index. A replacement never needs room: it frees the slot it takes.

        Raises ``ValueError`` if ``tx.id`` is already pooled under another idempotency_key. Ids are
        assigned by the gateway, so a clash is a bug on our side, not a client error (ADR-0008).
        """
        if tx.idempotency_key in self._by_idempotency_key:
            known = self._by_id[self._by_idempotency_key[tx.idempotency_key]]
            return AdmissionResult(Admission.DUPLICATE if known == tx else Admission.CONFLICT)

        if tx.id in self._by_id:
            raise ValueError(f"transaction id {tx.id!r} is already pooled under another key")

        if tx.is_expired(height):
            return AdmissionResult(Admission.EXPIRED)

        if tx.nonce < next_nonce:
            return AdmissionResult(Admission.STALE_NONCE)

        slot = (tx.account_id, tx.nonce)
        if slot in self._by_account_nonce:
            occupant_id = self._by_account_nonce[slot]
            if tx.priority_fee <= self._by_id[occupant_id].priority_fee:
                return AdmissionResult(Admission.UNDERPRICED)
            self.remove(occupant_id)
            result = AdmissionResult(Admission.REPLACED, evicted=occupant_id)
        elif len(self) < self.max_size:
            result = AdmissionResult(Admission.ACCEPTED)
        else:
            # lowest fee first; on a tie, -arrival makes the latest comer the minimum (ADR-0009)
            cheapest = min(
                self._by_id, key=lambda i: (self._by_id[i].priority_fee, -self._arrival[i])
            )
            if tx.priority_fee <= self._by_id[cheapest].priority_fee:
                return AdmissionResult(Admission.POOL_FULL)
            self.remove(cheapest)
            result = AdmissionResult(Admission.ACCEPTED, evicted=cheapest)

        self._by_id[tx.id] = tx
        self._by_idempotency_key[tx.idempotency_key] = tx.id
        self._by_account_nonce[slot] = tx.id
        self._arrival[tx.id] = self._next_arrival
        self._next_arrival += 1
        return result

    def remove(self, tx_id: str) -> None:
        """Drop a transaction from every index. No-op if absent."""
        tx = self._by_id.pop(tx_id, None)
        if tx is None:
            return
        del self._by_idempotency_key[tx.idempotency_key]
        del self._by_account_nonce[(tx.account_id, tx.nonce)]
        del self._arrival[tx_id]

    def expire(self, height: int) -> tuple[str, ...]:
        """Drop every transaction expired at ``height``; return their ids in arrival order."""
        expired = tuple(t.id for t in self.candidates() if t.is_expired(height))
        for tx_id in expired:
            self.remove(tx_id)
        return expired

    def candidates(self) -> tuple[Transaction, ...]:
        """Every pooled transaction in arrival order, as a tuple the builder cannot edit."""
        return tuple(sorted(self._by_id.values(), key=lambda t: self._arrival[t.id]))
