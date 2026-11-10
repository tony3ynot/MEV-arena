"""One block of the arena: the pure step that experiments and the 3-second clock both call.

Per block, in this order: the reference price walks one step, expired transactions leave the
mempool, the bots decide and their orders are admitted, the builder picks and orders a block,
the block executes, and every included transaction (executed or failed) leaves the mempool.
"""

import random
from collections.abc import Sequence
from dataclasses import dataclass

from simulation_engine.block_builder import BuilderPolicy, build_block
from simulation_engine.bots import Bot, BotView, Order, next_reference_price
from simulation_engine.events import (
    BlockProposed,
    DropReason,
    Payload,
    TransactionAccepted,
    TransactionDropped,
    TransactionRejected,
    events_for_block,
)
from simulation_engine.execution import WorldState, execute_block
from simulation_engine.mempool import Admission, AdmissionResult, Mempool
from simulation_engine.models import ExecutionReceipt, Transaction


@dataclass(frozen=True, slots=True)
class ArenaConfig:
    policy: BuilderPolicy
    capacity: int
    seed: int
    volatility_bps: int = 10
    """Reference-price step bound, per block (``next_reference_price``)."""


@dataclass(frozen=True, slots=True)
class Submission:
    """One bot order, the transaction it became, and the mempool's verdict on it."""

    order: Order
    transaction: Transaction
    result: AdmissionResult


@dataclass(frozen=True, slots=True)
class BlockOutcome:
    height: int
    reference_price: int
    """This block's reference price, the one the bots saw."""
    expired: tuple[str, ...]
    """Ids dropped from the mempool at the start of the block."""
    submissions: tuple[Submission, ...]
    """Every order sent this block, in arrival order, accepted or not."""
    block: tuple[Transaction, ...]
    """What the builder picked, in execution order."""
    receipts: tuple[ExecutionReceipt, ...]


def run_block(
    world: WorldState,
    mempool: Mempool,
    bots: Sequence[Bot],
    *,
    height: int,
    reference_price: int,
    config: ArenaConfig,
) -> tuple[WorldState, BlockOutcome]:
    """Advance the arena by one block and return the new world state and what happened.

    ``world`` is the last committed state and is not mutated. ``mempool`` is advanced in place.
    ``reference_price`` is the previous block's; the outcome carries this block's.

    The bots act one after another in list order. Each sees ``world``, this block's reference
    price, and the mempool as it is at its turn, so a later bot sees what earlier bots sent.
    The i-th order a bot sends becomes a transaction with idempotency key
    ``"{account_id}:{height}:{i}"``, id ``"{height}.{n}"`` for the n-th order of the block, and
    ``submitted_at = height``. A rejected order is reported in the outcome, never raised.

    Every random draw comes from ``config.seed`` through string seeds, which are the same in
    every process (``hash()`` is not):
    - reference price: ``random.Random(f"{seed}:reference:{height}")``
    - each bot: ``random.Random(f"{seed}:{account_id}:{height}")``
    - RANDOM builder: ``random.Random(f"{seed}:builder:{height}").getrandbits(64)``
    """
    seed = config.seed
    # 1. Reference price update
    ref = next_reference_price(
        reference_price, random.Random(f"{seed}:reference:{height}"), config.volatility_bps
    )
    # 2. Update expired block
    expired = mempool.expire(height)

    # 3. Bots submissions
    submissions: list[Submission] = []
    for bot in bots:
        view = BotView(height, world, mempool.candidates(), ref)
        orders = bot.decide(view, random.Random(f"{seed}:{bot.account_id}:{height}"))
        for i, order in enumerate(orders):
            tx = order.to_transaction(
                f"{height}.{len(submissions)}", f"{bot.account_id}:{height}:{i}", height
            )
            result = mempool.add(tx, world.next_nonce(tx.account_id), height=height)
            submissions.append(Submission(order, tx, result))

    # 4. Build & execute
    block = build_block(
        mempool.candidates(),
        world.next_nonce,
        policy=config.policy,
        capacity=config.capacity,
        seed=random.Random(f"{seed}:builder:{height}").getrandbits(64),
    )
    after, receipts = execute_block(world, block, height)

    # 5. Remove after block
    for tx in block:
        mempool.remove(tx.id)
    return after, BlockOutcome(height, ref, expired, tuple(submissions), block, receipts)


def events_for_outcome(
    outcome: BlockOutcome, policy: BuilderPolicy, after: WorldState, state_root: str
) -> tuple[Payload, ...]:
    """Every event one block produces, in emission order.

    Expired transactions are dropped first. Then each submission in arrival order: accepted
    (followed by a drop of whatever it replaced or evicted) or rejected. Then the proposed block,
    then what ``events_for_block`` derives from its execution.

    ``policy`` is the one ``run_block`` was called with. ``after`` is the state the block produced
    and ``state_root`` its hash; the caller computes the hash once and reuses it for snapshots.
    Replaying these events over the mempool as it was before the block (accepted: add; dropped or
    executed: remove) gives the mempool after it.
    """
    out: list[Payload] = [TransactionDropped(tx_id, "expired") for tx_id in outcome.expired]
    for sub in outcome.submissions:
        verdict, tx = sub.result.verdict, sub.transaction
        if verdict in (Admission.ACCEPTED, Admission.REPLACED):
            out.append(TransactionAccepted(tx))
            if sub.result.evicted is not None:
                reason: DropReason = "replaced" if verdict is Admission.REPLACED else "evicted"
                out.append(TransactionDropped(sub.result.evicted, reason))
        else:
            out.append(TransactionRejected(tx.idempotency_key, tx.account_id, verdict))
    out.append(BlockProposed(outcome.height, policy, tuple(tx.id for tx in outcome.block)))
    out.extend(events_for_block(outcome.block, outcome.receipts, after, outcome.height, state_root))
    return tuple(out)
