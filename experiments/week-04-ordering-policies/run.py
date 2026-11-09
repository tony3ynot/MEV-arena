"""Week-4 question: with the same bots and the same seeds, how much does the builder policy alone
change what the sandwich bot earns and what its victims pay?

Runs the pure arena (``simulation_engine.arena.run_block``) for every policy × seed and prints
markdown tables for the README. No I/O, no wall clock: the same arguments print the same tables.
"""

import argparse
import functools
import random
import statistics
import sys
import time
from collections import Counter
from dataclasses import dataclass, field

from simulation_engine.amm import apply_swap
from simulation_engine.arena import ArenaConfig, BlockOutcome, run_block
from simulation_engine.block_builder import BuilderPolicy
from simulation_engine.bots import (
    ArbitrageBot,
    Bot,
    BotView,
    NoiseTrader,
    Order,
    SandwichBot,
    max_front_run,
)
from simulation_engine.execution import WorldState, execute_block
from simulation_engine.mempool import Admission, Mempool
from simulation_engine.models import BPS, SCALE, AccountBalance, MarketState, TransactionStatus

POOL_ETH = 1_000
"""Pool depth in ETH, at 1,000 USDC per ETH. Start balances scale with it."""
NOISE_SIZE = (SCALE // 10, 30 * SCALE)
"""Noise trade sizes, log-uniform, in ETH units. Only the ratio to POOL_ETH matters to the AMM."""
MARKET = MarketState(
    "eth-usdc",
    POOL_ETH * SCALE,
    POOL_ETH * 1_000 * SCALE,
    fee_bps=30,
    base_asset="ETH",
    quote_asset="USDC",
)
POLICIES = (BuilderPolicy.FIFO, BuilderPolicy.PRIORITY_FEE, BuilderPolicy.RANDOM)
CAPACITY = 10
NOISE_TRADERS = 20
START = {  # account prefix -> (ETH, USDC): a tenth of the pool each, the arbitrage bot the whole
    "noise": (POOL_ETH // 10 * SCALE, POOL_ETH * 100 * SCALE),
    "arb": (POOL_ETH * SCALE, POOL_ETH * 1_000 * SCALE),
    "sandwich": (POOL_ETH // 10 * SCALE, POOL_ETH * 100 * SCALE),
}
SANDWICH = "sandwich-0"
OUTCOMES = ("wrapped", "victim first", "back before victim", "victim reverted", "incomplete")
"""How a sandwich attempt ended, judged within the block it was sent in:
wrapped: front-run → victim → back-run, victim executed. victim first: the victim came before the
front-run. back before victim: the back-run came before the victim. victim reverted: wrapped, but
the victim failed (something moved the price in between). incomplete: one of the three did not
make it into that block."""


@dataclass
class TracingSandwich:
    """A SandwichBot that also writes down which pending transaction it targeted.

    SandwichBot does not say who its victim is. Its orders give it away: the front-run trades the
    victim's side, bids the victim's fee + 1, expires with the victim, and is sized by
    ``max_front_run`` for that victim.
    """

    inner: SandwichBot
    targets: dict[int, str] = field(default_factory=dict[int, str])
    """height -> victim transaction id"""

    @property
    def account_id(self) -> str:
        return self.inner.account_id

    def decide(self, view: BotView, rng: random.Random) -> tuple[Order, ...]:
        orders = self.inner.decide(view, rng)
        if orders:
            self.targets[view.height] = _victim_of(orders[0], view)
        return orders


def _victim_of(front: Order, view: BotView) -> str:
    market = view.state.markets[front.market_id]
    asset = market.base_asset if front.side.value == "sell" else market.quote_asset
    balance = view.state.balance_of(front.account_id, asset)
    for tx in view.pending:
        if (
            tx.account_id != front.account_id
            and tx.side is front.side
            and tx.priority_fee + 1 == front.priority_fee
            and tx.expires_at == front.expires_at
            and max_front_run(market, tx, balance) == front.amount_in
        ):
            return tx.id
    raise AssertionError(f"no pending transaction matches the front-run {front}")


@dataclass
class RunResult:
    attempts: Counter[str] = field(default_factory=Counter[str])
    sandwich_pnl: int = 0
    """Quote units, holdings valued at the final reference price, against the start."""
    arb_pnl: int = 0
    victim_cost: list[int] = field(default_factory=list[int])
    """bps, wrapped victims: how much less they got than on the state just before the front-run.

    Not the receipt's slippage_bps: that is measured against the price at execution, which the
    front-run had already moved, so it leaves out exactly what the sandwich took."""
    other_slippage: list[int] = field(default_factory=list[int])
    """bps, receipt slippage of every other executed noise swap."""
    noise_executed: int = 0
    noise_failed: int = 0
    noise_sent: int = 0
    prey: int = 0
    """Noise swaps the sandwich bot would have attacked had it seen them alone."""


def _world(accounts: list[str]) -> WorldState:
    balances: dict[tuple[str, str], AccountBalance] = {}
    for a in accounts:
        eth, usdc = START[a.split("-")[0]]
        balances[(a, "ETH")] = AccountBalance(a, "ETH", eth)
        balances[(a, "USDC")] = AccountBalance(a, "USDC", usdc)
    return WorldState(markets={"eth-usdc": MARKET}, balances=balances)


def _pnl(world: WorldState, account: str, reference: int) -> int:
    eth, usdc = START[account.split("-")[0]]
    d_eth = world.balance_of(account, "ETH") - eth
    d_usdc = world.balance_of(account, "USDC") - usdc
    return d_eth * reference // SCALE + d_usdc


def _classify(out: BlockOutcome, front: str, victim: str, back: str) -> str:
    position = {tx.id: i for i, tx in enumerate(out.block)}
    if not {front, victim, back} <= position.keys():
        return "incomplete"
    if position[victim] < position[front]:
        return "victim first"
    if position[back] < position[victim]:
        return "back before victim"
    if out.receipts[position[victim]].status is TransactionStatus.FAILED:
        return "victim reverted"
    return "wrapped"


def _victim_cost(before: WorldState, out: BlockOutcome, front: str, victim: str) -> int:
    """bps the victim lost to the front-run: replay the block up to the front-run, quote there."""
    position = {tx.id: i for i, tx in enumerate(out.block)}
    just_before, _ = execute_block(before, out.block[: position[front]], out.height)
    tx = out.block[position[victim]]
    would_get = apply_swap(just_before.markets[tx.market_id], tx.side, tx.amount_in)[1]
    got = out.receipts[position[victim]].amount_out
    return (would_get - got) * BPS // would_get


@functools.cache  # the tables share runs; a run is a pure function of its arguments
def run(policy: BuilderPolicy, seed: int, blocks: int, tolerance_bps: int = 100) -> RunResult:
    noise: list[Bot] = [
        NoiseTrader(
            f"noise-{i}",
            "eth-usdc",
            min_size=NOISE_SIZE[0],
            max_size=NOISE_SIZE[1],
            tolerance_bps=tolerance_bps,
        )
        for i in range(NOISE_TRADERS)
    ]
    arb = ArbitrageBot("arb-0", "eth-usdc")
    sandwich = TracingSandwich(SandwichBot(SANDWICH))
    bots: list[Bot] = [*noise, arb, sandwich]  # the sandwich bot looks last, so it sees the flow
    world = _world([b.account_id for b in bots])
    pool, reference = Mempool(), MARKET.last_price
    config = ArenaConfig(policy, CAPACITY, seed)
    result = RunResult()

    for height in range(1, blocks + 1):
        before = world
        world, out = run_block(
            world, pool, bots, height=height, reference_price=reference, config=config
        )
        reference = out.reference_price

        for sub in out.submissions:
            tx = sub.transaction
            if (
                not tx.account_id.startswith("noise-")
                or sub.result.verdict is not Admission.ACCEPTED
            ):
                continue
            result.noise_sent += 1
            alone = BotView(height, before, (tx,), reference)
            if SandwichBot(SANDWICH).decide(alone, random.Random(0)):
                result.prey += 1

        wrapped: set[str] = set()
        if height in sandwich.targets:
            ids = {
                s.transaction.idempotency_key.rsplit(":", 1)[1]: s.transaction.id
                for s in out.submissions
                if s.transaction.account_id == SANDWICH
            }
            victim = sandwich.targets[height]
            outcome = _classify(out, ids["0"], victim, ids["1"])
            result.attempts[outcome] += 1
            if outcome == "wrapped":
                wrapped.add(victim)
                result.victim_cost.append(_victim_cost(before, out, ids["0"], victim))

        for tx, receipt in zip(out.block, out.receipts, strict=True):
            if not tx.account_id.startswith("noise-"):
                continue
            if receipt.status is TransactionStatus.EXECUTED:
                result.noise_executed += 1
                if tx.id not in wrapped:
                    result.other_slippage.append(receipt.slippage_bps)
            else:
                result.noise_failed += 1

    result.sandwich_pnl = _pnl(world, SANDWICH, reference)
    result.arb_pnl = _pnl(world, arb.account_id, reference)
    return result


def arb_alone(seed: int, blocks: int, volatility_bps: int = 10) -> tuple[int, int]:
    """No noise, no sandwich: in how many blocks does the arbitrage bot trade at all?"""
    arb = ArbitrageBot("arb-0", "eth-usdc")
    world, pool, reference = _world([arb.account_id]), Mempool(), MARKET.last_price
    config = ArenaConfig(BuilderPolicy.FIFO, CAPACITY, seed, volatility_bps)
    traded = 0
    for height in range(1, blocks + 1):
        world, out = run_block(
            world, pool, [arb], height=height, reference_price=reference, config=config
        )
        reference = out.reference_price
        traded += any(r.status is TransactionStatus.EXECUTED for r in out.receipts)
    return traded, blocks


def _usdc(units: float) -> str:
    return f"{units / SCALE:,.2f}"


def _p95(values: list[int]) -> str:
    return str(statistics.quantiles(values, n=20)[18]) if len(values) >= 2 else "–"


def _mean(values: list[int]) -> str:
    return f"{statistics.fmean(values):.1f}" if values else "–"


def _spread(values: list[int]) -> str:
    sd = statistics.stdev(values) if len(values) >= 2 else 0
    return f"{_usdc(statistics.fmean(values))} ± {_usdc(sd)}"


def _policy_table(seeds: range, blocks: int) -> None:
    print(f"### Policies ({len(seeds)} seeds × {blocks} blocks, capacity {CAPACITY})\n")
    print(
        "| policy | attempts | "
        + " | ".join(OUTCOMES)
        + " | sandwich P&L, USDC | arb P&L, USDC | victim cost mean / p95, bps"
        + " | other noise slippage mean, bps | noise failed |"
    )
    print("|---" * (len(OUTCOMES) + 7) + "|")
    for policy in POLICIES:
        runs = [run(policy, seed, blocks) for seed in seeds]
        attempts = sum((r.attempts for r in runs), Counter[str]())
        total = sum(attempts.values())
        shares = [f"{attempts[o] / total:.0%}" if total else "–" for o in OUTCOMES]
        victims = [s for r in runs for s in r.victim_cost]
        others = [s for r in runs for s in r.other_slippage]
        failed = sum(r.noise_failed for r in runs)
        executed = sum(r.noise_executed for r in runs)
        print(
            f"| {policy.value} | {total} | "
            + " | ".join(shares)
            + f" | {_spread([r.sandwich_pnl for r in runs])}"
            + f" | {_spread([r.arb_pnl for r in runs])}"
            + f" | {_mean(victims)} / {_p95(victims)} | {_mean(others)}"
            + f" | {failed / (failed + executed):.1%} |"
        )
    print()


def _tolerance_table(seeds: range, blocks: int) -> None:
    print(f"### Victim tolerance under priority_fee ({len(seeds)} seeds × {blocks} blocks)\n")
    print("| noise tolerance | sandwich P&L, USDC | × vs first row |")
    print("|---|---|---|")
    base: float | None = None
    for tolerance in (50, 100, 200):
        pnl = [run(BuilderPolicy.PRIORITY_FEE, s, blocks, tolerance).sandwich_pnl for s in seeds]
        mean = statistics.fmean(pnl)
        base = base or mean
        print(f"| {tolerance / 100:.1f} % | {_spread(pnl)} | {mean / base:.2f} |")
    print()


def _prey_table(seeds: range, blocks: int) -> None:
    runs = [run(BuilderPolicy.PRIORITY_FEE, s, blocks) for s in seeds]
    prey, sent = sum(r.prey for r in runs), sum(r.noise_sent for r in runs)
    print(f"### Noise swaps worth sandwiching ({len(seeds)} seeds × {blocks} blocks)\n")
    print(f"{prey} of {sent} accepted noise swaps = **{prey / sent:.1%}**\n")


def _arb_table(seeds: range, blocks: int) -> None:
    traded = [arb_alone(s, blocks) for s in seeds]
    hit, total = sum(t for t, _ in traded), sum(n for _, n in traded)
    per_seed = [t / n for t, n in traded]
    print(f"### Arbitrage bot alone, reference ±10 bps per block ({len(seeds)} seeds × {blocks})\n")
    print(
        f"traded in {hit} of {total} blocks = **{hit / total:.1%}** "
        f"(per seed {min(per_seed):.1%}–{max(per_seed):.1%})\n"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seeds", type=int, default=20)
    parser.add_argument("--blocks", type=int, default=200)
    args = parser.parse_args()
    seeds = range(args.seeds)

    started = time.perf_counter()
    _policy_table(seeds, args.blocks)
    _tolerance_table(seeds, args.blocks)
    _prey_table(seeds, args.blocks)
    _arb_table(seeds, args.blocks * 5)
    print(f"({time.perf_counter() - started:.0f} s)", file=sys.stderr)


if __name__ == "__main__":
    main()
