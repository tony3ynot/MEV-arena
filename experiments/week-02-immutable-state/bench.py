"""How does execute_block throughput scale with the number of accounts?

The engine copies the whole balances dict on every executed transaction. Vary accounts, keep
transactions per block fixed, report tx/s and µs per tx.
"""

import random
import sys
import time

from simulation_engine.execution import WorldState, execute_block
from simulation_engine.models import SCALE, AccountBalance, MarketState, Side, Transaction

MARKET = MarketState(
    "eth-usdc", 10_000 * SCALE, 10_000_000 * SCALE, 30, base_asset="ETH", quote_asset="USDC"
)
TXS_PER_BLOCK = 2_000


def world(accounts: int) -> WorldState:
    balances: dict[tuple[str, str], AccountBalance] = {}
    for i in range(accounts):
        a = f"acct-{i}"
        balances[(a, "ETH")] = AccountBalance(a, "ETH", 1_000 * SCALE)
        balances[(a, "USDC")] = AccountBalance(a, "USDC", 1_000_000 * SCALE)
    return WorldState(markets={"eth-usdc": MARKET}, balances=balances)


def block(accounts: int, rng: random.Random) -> list[Transaction]:
    nonces = [0] * accounts
    txs: list[Transaction] = []
    for i in range(TXS_PER_BLOCK):
        k = rng.randrange(accounts)
        side = rng.choice([Side.SELL, Side.BUY])
        amt = rng.randint(1, 10) * SCALE * (1 if side is Side.SELL else 1_000)
        txs.append(
            Transaction(
                f"t{i}", f"i{i}", f"acct-{k}", nonces[k], "eth-usdc", side, amt, 0, 0, 0, 10
            )
        )
        nonces[k] += 1
    return txs


def main() -> None:
    rng = random.Random(42)
    print(f"{'accounts':>8} {'entries':>8} {'tx/s':>9} {'µs/tx':>8} {'executed':>8}")
    for accounts in (100, 1_000, 10_000):
        s0, txs = world(accounts), block(accounts, rng)
        best = float("inf")
        _, receipts = execute_block(s0, txs, 1)
        for _ in range(3):
            t = time.perf_counter()
            execute_block(s0, txs, 1)
            best = min(best, time.perf_counter() - t)
        ok = sum(r.status == "executed" for r in receipts)
        us = best / TXS_PER_BLOCK * 1e6
        print(
            f"{accounts:>8} {len(s0.balances):>8} {TXS_PER_BLOCK / best:>9.0f} {us:>8.1f} {ok:>8}"
        )


if __name__ == "__main__":
    sys.exit(main())
