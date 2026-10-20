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
    """New transaction stored."""
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


@dataclass
class Mempool:
    """Pending transactions, keyed for the three lookups admission needs.

    Invariants (tests check them):
    - one transaction per idempotency_key
    - one transaction per (account_id, nonce)
    - ``arrival`` is a strictly increasing sequence number, never reused
    """

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

    def __len__(self) -> int:
        return len(self._by_id)

    def __contains__(self, tx_id: str) -> bool:
        return tx_id in self._by_id

    def get(self, tx_id: str) -> Transaction | None:
        return self._by_id.get(tx_id)

    def arrival_of(self, tx_id: str) -> int:
        return self._arrival[tx_id]

    def add(self, tx: Transaction, next_nonce: int) -> Admission:
        """Admit ``tx`` or say why not.

        ``next_nonce`` is the account's next expected nonce, read from world state by the caller.
        Check order: idempotency_key -> nonce -> (account, nonce) replacement. Stop at the first
        verdict. On REPLACED, the old transaction must disappear from *every* index.
        """
        if tx.idempotency_key in self._by_idempotency_key:
            known = self._by_id[self._by_idempotency_key[tx.idempotency_key]]
            return Admission.DUPLICATE if known == tx else Admission.CONFLICT

        if tx.nonce < next_nonce:
            return Admission.STALE_NONCE

        slot = (tx.account_id, tx.nonce)
        verdict = Admission.ACCEPTED
        if slot in self._by_account_nonce:
            occupant_id = self._by_account_nonce[slot]
            if tx.priority_fee <= self._by_id[occupant_id].priority_fee:
                return Admission.UNDERPRICED
            self.remove(occupant_id)
            verdict = Admission.REPLACED

        self._by_id[tx.id] = tx
        self._by_idempotency_key[tx.idempotency_key] = tx.id
        self._by_account_nonce[slot] = tx.id
        self._arrival[tx.id] = self._next_arrival
        self._next_arrival += 1
        return verdict

    def remove(self, tx_id: str) -> None:
        """Drop a transaction from every index. No-op if absent."""
        tx = self._by_id.pop(tx_id, None)
        if tx is None:
            return
        del self._by_idempotency_key[tx.idempotency_key]
        del self._by_account_nonce[(tx.account_id, tx.nonce)]
        del self._arrival[tx_id]
