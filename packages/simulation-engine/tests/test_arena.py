"""run_block: one block of bots → mempool → builder → execution, deterministic from one seed."""

import random
from collections.abc import Iterable
from dataclasses import dataclass, field, replace

import pytest
from simulation_engine.amm import get_amount_out
from simulation_engine.arena import ArenaConfig, BlockOutcome, events_for_outcome, run_block
from simulation_engine.block_builder import BuilderPolicy
from simulation_engine.bots import (
    ArbitrageBot,
    Bot,
    BotView,
    NoiseTrader,
    Order,
    SandwichBot,
    next_reference_price,
)
from simulation_engine.events import (
    BlockProposed,
    Payload,
    TransactionAccepted,
    TransactionDropped,
    TransactionExecuted,
    TransactionRejected,
)
from simulation_engine.execution import WorldState, execute_block, state_hash
from simulation_engine.mempool import Admission, Mempool
from simulation_engine.models import SCALE, AccountBalance, MarketState, Side, TransactionStatus

MARKET = MarketState(
    "eth-usdc", 1_000 * SCALE, 1_000_000 * SCALE, fee_bps=30, base_asset="ETH", quote_asset="USDC"
)
PRICE = MARKET.last_price
CONFIG = ArenaConfig(BuilderPolicy.FIFO, capacity=10, seed=7)


@dataclass(frozen=True)
class Scripted:
    """Sends the same orders at every height."""

    account_id: str
    orders: tuple[Order, ...] = ()

    def decide(self, view: BotView, rng: random.Random) -> tuple[Order, ...]:
        return self.orders


@dataclass
class Recorder:
    """Sends nothing; remembers each view it was shown and the first number its rng drew."""

    account_id: str
    seen: list[tuple[BotView, float]] = field(default_factory=list[tuple[BotView, float]])

    def decide(self, view: BotView, rng: random.Random) -> tuple[Order, ...]:
        self.seen.append((view, rng.random()))
        return ()


def _order(
    account: str,
    nonce: int = 0,
    *,
    side: Side = Side.SELL,
    amount: int = SCALE,
    min_out: int = 0,
    fee: int = 0,
    expires: int = 10,
) -> Order:
    return Order(account, nonce, "eth-usdc", side, amount, min_out, fee, expires)


def _world(*accounts: str, nonces: dict[str, int] | None = None) -> WorldState:
    plenty = 10**9 * SCALE
    balances = {
        (a, asset): AccountBalance(a, asset, plenty) for a in accounts for asset in ("ETH", "USDC")
    }
    return WorldState(markets={"eth-usdc": MARKET}, balances=balances, nonces=nonces or {})


def _run(
    world: WorldState,
    bots: list[Bot],
    *,
    height: int = 1,
    mempool: Mempool | None = None,
    config: ArenaConfig = CONFIG,
) -> tuple[WorldState, BlockOutcome]:
    return run_block(
        world,
        Mempool() if mempool is None else mempool,
        bots,
        height=height,
        reference_price=PRICE,
        config=config,
    )


def test_an_empty_arena_still_walks_the_reference_price():
    world = _world()
    after, out = _run(world, [])

    assert (out.block, out.receipts, out.submissions, out.expired) == ((), (), (), ())
    assert after == world
    expected = next_reference_price(PRICE, random.Random("7:reference:1"), CONFIG.volatility_bps)
    assert out.reference_price == expected


def test_orders_get_keys_and_ids_and_arrive_in_bot_order():
    bots: list[Bot] = [
        Scripted("a", (_order("a", 0), _order("a", 1))),
        Scripted("b", (_order("b", 0),)),
    ]
    _, out = _run(_world("a", "b"), bots, height=3)

    txs = [s.transaction for s in out.submissions]
    assert [t.idempotency_key for t in txs] == ["a:3:0", "a:3:1", "b:3:0"]
    assert [t.id for t in txs] == ["3.0", "3.1", "3.2"]
    assert all(t.submitted_at == 3 for t in txs)
    assert [s.order for s in out.submissions] == [_order("a", 0), _order("a", 1), _order("b", 0)]
    assert all(s.result.verdict is Admission.ACCEPTED for s in out.submissions)


def test_each_bot_sees_the_committed_state_and_what_earlier_bots_sent():
    world = _world("a")
    recorder = Recorder("rec")
    _, out = _run(world, [Scripted("a", (_order("a"),)), recorder])

    ((view, _),) = recorder.seen
    assert view.state == world
    assert view.height == 1
    assert view.reference_price == out.reference_price
    assert [t.id for t in view.pending] == ["1.0"]


def test_each_bot_draws_from_its_own_seed():
    recorder = Recorder("rec")
    _run(_world(), [recorder], height=5)

    ((_, draw),) = recorder.seen
    assert draw == random.Random("7:rec:5").random()


def test_rejections_are_reported_not_raised():
    world = _world("a", nonces={"a": 2})
    after, out = _run(world, [Scripted("a", (_order("a", nonce=0),))])

    (sub,) = out.submissions
    assert sub.result.verdict is Admission.STALE_NONCE
    assert out.block == ()
    assert after == world


def test_included_transactions_leave_the_pool_and_the_rest_wait():
    pool = Mempool()
    bots: list[Bot] = [Scripted("a", (_order("a"),)), Scripted("b", (_order("b"),))]
    _, out = _run(_world("a", "b"), bots, mempool=pool, config=replace(CONFIG, capacity=1))

    assert [t.id for t in out.block] == ["1.0"]
    assert [t.id for t in pool.candidates()] == ["1.1"]


def test_a_failed_transaction_leaves_the_pool_too():
    pool = Mempool()
    greedy = _order("a", min_out=10**9 * SCALE)  # can never get that much
    _, out = _run(_world("a"), [Scripted("a", (greedy,))], mempool=pool)

    (receipt,) = out.receipts
    assert receipt.status is TransactionStatus.FAILED
    assert pool.candidates() == ()


def test_expired_transactions_leave_before_the_bots_look():
    pool = Mempool()
    stale = _order("a", expires=1).to_transaction("old", "a:old", 0)
    pool.add(stale, 0, height=1)
    recorder = Recorder("rec")
    _, out = _run(_world("a"), [recorder], height=2, mempool=pool)

    assert out.expired == ("old",)
    assert recorder.seen[0][0].pending == ()
    assert out.block == ()


def test_the_world_advances_by_executing_the_block():
    world = _world("a", "b")
    bots: list[Bot] = [Scripted("a", (_order("a"),)), Scripted("b", (_order("b", side=Side.BUY),))]
    after, out = _run(world, bots)

    assert (after, out.receipts) == execute_block(world, out.block, 1)
    assert after.next_nonce("a") == after.next_nonce("b") == 1


@pytest.mark.parametrize(
    ("policy", "sandwiched"), [(BuilderPolicy.PRIORITY_FEE, True), (BuilderPolicy.FIFO, False)]
)
def test_a_sandwich_lands_only_when_the_builder_sorts_by_fee(
    policy: BuilderPolicy, sandwiched: bool
):
    """The victim is sent before the bot looks, so it always arrives first."""
    quote = get_amount_out(10 * SCALE, MARKET.base_reserve, MARKET.quote_reserve, MARKET.fee_bps)
    victim = _order("victim", amount=10 * SCALE, min_out=quote * 99 // 100, fee=50)
    bot = SandwichBot("sandwich-0")
    _, out = _run(
        _world("victim", bot.account_id),
        [Scripted("victim", (victim,)), bot],
        config=replace(CONFIG, policy=policy),
    )

    owners = [t.account_id for t in out.block]
    assert owners == (
        ["sandwich-0", "victim", "sandwich-0"]
        if sandwiched
        else ["victim", "sandwich-0", "sandwich-0"]
    )


def _arena_run(
    policy: BuilderPolicy, seed: int, blocks: int = 20
) -> tuple[str, list[BlockOutcome]]:
    noise = [NoiseTrader(f"noise-{i}", "eth-usdc") for i in range(10)]
    bots: list[Bot] = [*noise, ArbitrageBot("arb-0", "eth-usdc"), SandwichBot("sandwich-0")]
    world = _world(*(b.account_id for b in bots))
    pool, price, outcomes = Mempool(), PRICE, list[BlockOutcome]()
    config = ArenaConfig(policy, capacity=8, seed=seed)
    for height in range(1, blocks + 1):
        world, out = run_block(
            world, pool, bots, height=height, reference_price=price, config=config
        )
        price = out.reference_price
        outcomes.append(out)
    return state_hash(world), outcomes


def test_same_seed_same_run_and_another_seed_another_run():
    hash_a, outcomes_a = _arena_run(BuilderPolicy.RANDOM, seed=1)
    hash_b, outcomes_b = _arena_run(BuilderPolicy.RANDOM, seed=1)
    hash_c, _ = _arena_run(BuilderPolicy.RANDOM, seed=2)

    assert (hash_a, outcomes_a) == (hash_b, outcomes_b)
    assert hash_c != hash_a
    assert sum(len(o.block) for o in outcomes_a) > 0, "the run actually traded"


def test_the_builder_seed_differs_per_block():
    """The same six orders at different heights must not get the same RANDOM shuffle.

    With one seed for every block, the k-th arrival would draw the same number every time.
    """
    accounts = [f"u{i}" for i in range(6)]
    bots: list[Bot] = [Scripted(a, (_order(a, expires=99),)) for a in accounts]
    config = replace(CONFIG, policy=BuilderPolicy.RANDOM)

    shuffles = {
        tuple(t.account_id for t in _run(_world(*accounts), bots, height=h, config=config)[1].block)
        for h in range(1, 6)
    }
    assert len(shuffles) > 1


# ---- events_for_outcome --------------------------------------------------------------------


def _events(after: WorldState, out: BlockOutcome, policy: BuilderPolicy = CONFIG.policy):
    return events_for_outcome(out, policy, after, state_hash(after))


def _track(pending: set[str], events: Iterable[Payload]) -> set[str]:
    """What a stream consumer such as the UI reducer knows of the pool, from the events alone."""
    pending = set(pending)
    for e in events:
        match e:
            case TransactionAccepted():
                pending.add(e.transaction.id)
            case TransactionDropped() | TransactionExecuted():
                pending.discard(e.transaction_id)
            case _:
                pass
    return pending


@pytest.mark.parametrize("policy", list(BuilderPolicy))
def test_the_events_alone_track_the_mempool(policy: BuilderPolicy):
    """A small pool and a small block force expiries and evictions along the way."""
    noise = [NoiseTrader(f"noise-{i}", "eth-usdc") for i in range(10)]
    bots: list[Bot] = [*noise, ArbitrageBot("arb-0", "eth-usdc"), SandwichBot("sandwich-0")]
    world = _world(*(b.account_id for b in bots))
    pool, price, pending = Mempool(max_size=8), PRICE, set[str]()
    config = ArenaConfig(policy, capacity=3, seed=11)
    reasons: set[str] = set()
    for height in range(1, 41):
        world, out = run_block(
            world, pool, bots, height=height, reference_price=price, config=config
        )
        price = out.reference_price
        events = _events(world, out, policy)
        pending = _track(pending, events)
        reasons |= {e.reason for e in events if isinstance(e, TransactionDropped)}
        assert pending == {t.id for t in pool.candidates()}, f"height {height}"
    assert {"expired", "evicted"} <= reasons, "the run exercised both drop paths"


def test_one_block_emits_drops_and_verdicts_then_the_block_then_its_execution():
    pool = Mempool()
    pool.add(_order("a", expires=1).to_transaction("old", "a:old", 0), 0, height=1)
    world = _world("a", "b", nonces={"b": 1})
    bots: list[Bot] = [Scripted("a", (_order("a"),)), Scripted("b", (_order("b", nonce=0),))]
    after, out = _run(world, bots, height=2, mempool=pool)

    events = _events(after, out)
    assert [type(e).__name__ for e in events] == [
        "TransactionDropped",
        "TransactionAccepted",
        "TransactionRejected",
        "BlockProposed",
        "TransactionExecuted",
        "SwapExecuted",
        "MarketPriceUpdated",
        "BlockCommitted",
    ]
    assert events[:4] == (
        TransactionDropped("old", "expired"),
        TransactionAccepted(out.submissions[0].transaction),
        TransactionRejected("b:2:0", "b", Admission.STALE_NONCE),
        BlockProposed(2, CONFIG.policy, ("2.0",)),
    )


def test_a_replacement_reports_what_it_pushed_out():
    pool = Mempool()
    pool.add(_order("a", fee=1).to_transaction("cheap", "a:cheap", 0), 0, height=1)
    after, out = _run(_world("a"), [Scripted("a", (_order("a", fee=5),))], mempool=pool)

    assert _events(after, out)[:2] == (
        TransactionAccepted(out.submissions[0].transaction),
        TransactionDropped("cheap", "replaced"),
    )


def test_a_full_pool_reports_the_cheapest_as_evicted():
    pool = Mempool(max_size=1)
    pool.add(_order("b", fee=1).to_transaction("cheap", "b:cheap", 0), 0, height=1)
    after, out = _run(_world("a", "b"), [Scripted("a", (_order("a", fee=5),))], mempool=pool)

    assert _events(after, out)[:2] == (
        TransactionAccepted(out.submissions[0].transaction),
        TransactionDropped("cheap", "evicted"),
    )
