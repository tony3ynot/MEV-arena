"""Block building: pick and order transactions from the mempool's candidate set.

Every policy shares one skeleton (ADR-0011). Each account's transactions form a queue in nonce
order, and only a queue head carrying the account's next nonce may go in, so nothing is placed
where it would fail on BAD_NONCE. The policy decides only which of those heads goes first.
Transactions left out stay in the mempool and are candidates again next block.

Pure: the same candidates, nonces, capacity, and seed always give the same block.
"""

import heapq
import random
from collections.abc import Callable, Sequence
from enum import StrEnum

from simulation_engine.models import Transaction


class BuilderPolicy(StrEnum):
    FIFO = "fifo"
    """Earliest arrival first."""
    PRIORITY_FEE = "priority_fee"
    """Highest priority_fee first; earlier arrival on a tie."""
    RANDOM = "random"
    """A shuffle drawn from the block's seed."""


def build_block(
    candidates: Sequence[Transaction],
    next_nonce: Callable[[str], int],
    *,
    policy: BuilderPolicy,
    capacity: int,
    seed: int,
) -> tuple[Transaction, ...]:
    """Pick up to ``capacity`` transactions and put them in execution order.

    ``candidates`` come from ``Mempool.candidates()``, in arrival order. ``next_nonce`` gives an
    account's next expected nonce, e.g. ``WorldState.next_nonce``. ``seed`` matters only to
    RANDOM; the caller derives one per block from the simulation seed.
    """
    if capacity < 0:
        raise ValueError(f"capacity must be non-negative, got {capacity}")
    rank = _rank(policy, candidates, seed)

    # Per account, highest nonce first, so list.pop() takes the queue head.
    queues: dict[str, list[Transaction]] = {}
    for tx in sorted(candidates, key=lambda t: t.nonce, reverse=True):
        queues.setdefault(tx.account_id, []).append(tx)
    expected = {account: next_nonce(account) for account in queues}

    heads: list[tuple[int, Transaction]] = []  # min-heap on rank; ranks are unique

    def offer_head(account: str) -> None:
        queue = queues[account]
        while queue and queue[-1].nonce < expected[account]:
            queue.pop()  # nonce already used; can never execute
        if queue and queue[-1].nonce == expected[account]:
            tx = queue.pop()
            heapq.heappush(heads, (rank[tx.id], tx))

    for account in queues:
        offer_head(account)

    block: list[Transaction] = []
    while heads and len(block) < capacity:
        _, tx = heapq.heappop(heads)
        block.append(tx)
        expected[tx.account_id] += 1
        offer_head(tx.account_id)
    return tuple(block)


def _rank(policy: BuilderPolicy, candidates: Sequence[Transaction], seed: int) -> dict[str, int]:
    """tx id -> place in the policy's preference order, 0 first. Arrival breaks every tie."""
    arrival = range(len(candidates))
    match policy:
        case BuilderPolicy.FIFO:
            order = list(arrival)
        case BuilderPolicy.PRIORITY_FEE:
            order = sorted(arrival, key=lambda i: (-candidates[i].priority_fee, i))
        case BuilderPolicy.RANDOM:
            rng = random.Random(seed)  # a private generator: never the global one
            draws = [rng.random() for _ in arrival]
            order = sorted(arrival, key=lambda i: (draws[i], i))
    return {candidates[i].id: place for place, i in enumerate(order)}
