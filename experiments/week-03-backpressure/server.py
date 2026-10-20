"""A mempool behind HTTP for the week-03 experiment. See README.md.

POST /tx    {"id": str, "fee": int} -> Mempool.add. 202 when stored (possibly evicting a cheaper
            one), 429 on POOL_FULL: the backpressure signal a well-behaved producer slows down on.
Block task  every BLOCK_MS: expire, candidates, build_block(capacity=BLOCK_CAP), remove the picks.
            The consumer's nominal capacity is C = BLOCK_CAP / BLOCK_MS.
GET /stats  counters, depth, memory, and per-interval block-build time and wait-in-pool
            percentiles (reset by each call, so poll from one sampler only).

Every transaction comes from a fresh account with nonce 0, so nonces never hold anything back
and the pool's own policy is all that is measured.

Env: MAX_SIZE (default 1000; 0 = unbounded), BLOCK_CAP (40), BLOCK_MS (100), PORT (8000).
"""

import asyncio
import os
import time
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, Response
from pydantic import BaseModel
from simulation_engine.block_builder import BuilderPolicy, build_block
from simulation_engine.mempool import Admission, Mempool
from simulation_engine.models import Side, Transaction

MAX_SIZE = int(os.environ.get("MAX_SIZE", "1000")) or 10**12
BLOCK_CAP = int(os.environ.get("BLOCK_CAP", "40"))
BLOCK_MS = float(os.environ.get("BLOCK_MS", "100"))
PORT = int(os.environ.get("PORT", "8000"))
NEVER = 10**12  # expires_at: nothing expires here; expiry is not under test

pool = Mempool(max_size=MAX_SIZE)
height = 0
admitted: dict[str, tuple[float, int]] = {}
"""tx id -> (admission time, fee), for wait-in-pool and for who got shed"""
counts = {"accepted": 0, "pool_full": 0, "evicted": 0, "included": 0, "blocks": 0}
# reset by every GET /stats
waits: list[float] = []
build_ms: list[float] = []
included_fees: list[int] = []
shed_fees: list[int] = []
"""fees turned away (429) or pushed out (evicted)"""


def no_nonce_history(_account: str) -> int:
    return 0


async def produce_blocks() -> None:
    global height
    while True:
        started = time.monotonic()
        height += 1
        pool.expire(height)
        block = build_block(
            pool.candidates(),
            no_nonce_history,
            policy=BuilderPolicy.PRIORITY_FEE,
            capacity=BLOCK_CAP,
            seed=height,
        )
        now = time.monotonic()
        for tx in block:
            pool.remove(tx.id)
            waits.append(now - admitted.pop(tx.id)[0])
            included_fees.append(tx.priority_fee)
        counts["included"] += len(block)
        counts["blocks"] += 1
        elapsed = time.monotonic() - started
        build_ms.append(elapsed * 1000)
        await asyncio.sleep(max(0.0, BLOCK_MS / 1000 - elapsed))


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
    producer = asyncio.create_task(produce_blocks())
    yield
    producer.cancel()


app = FastAPI(title="week-03-backpressure", lifespan=lifespan)


class Submit(BaseModel):
    id: str
    fee: int


@app.post("/tx")
async def submit(body: Submit) -> Response:
    tx = Transaction(
        body.id, body.id, body.id, 0, "eth-usdc", Side.SELL, 1, 0, body.fee, height, NEVER
    )
    result = pool.add(tx, 0, height=height)
    if result.verdict is Admission.POOL_FULL:
        counts["pool_full"] += 1
        shed_fees.append(body.fee)
        return Response(status_code=429)
    counts["accepted"] += 1
    admitted[tx.id] = (time.monotonic(), body.fee)
    if result.evicted is not None:
        counts["evicted"] += 1
        shed_fees.append(admitted.pop(result.evicted)[1])
    return Response(status_code=202)


def percentile(xs: list[float], q: float) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    return s[min(len(s) - 1, int(q * len(s)))]


def mean(xs: list[int]) -> float | None:
    return sum(xs) / len(xs) if xs else None


def rss_mb() -> float:
    with open("/proc/self/statm") as f:
        return int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE") / 2**20


@app.get("/stats")
async def stats() -> dict[str, float | int | None]:
    out: dict[str, float | int | None] = {
        **counts,
        "depth": len(pool),
        "height": height,
        "rss_mb": round(rss_mb(), 1),
        "wait_p50_s": percentile(waits, 0.50),
        "wait_p99_s": percentile(waits, 0.99),
        "build_ms_max": max(build_ms, default=None),
        "included_fee_mean": mean(included_fees),
        "shed_fee_mean": mean(shed_fees),
    }
    for xs in (waits, build_ms, included_fees, shed_fees):
        xs.clear()
    return out


if __name__ == "__main__":
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=PORT,
        workers=1,  # one event loop, as in week 1: the block task and the requests share it
        loop="uvloop",
        http="httptools",
        access_log=False,
        log_level="warning",
    )
