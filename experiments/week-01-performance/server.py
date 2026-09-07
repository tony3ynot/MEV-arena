"""Pool-gated FastAPI server for the week-01 experiment. See README.md.

GET /query  takes one slot from a fixed-size pool, then sleeps SERVICE_MS to stand in
            for a DB round-trip. The pool waits; it never rejects (bounded queues are week 3).
GET /stats  exposes the queue so the bottleneck is visible while a test runs.

Env: POOL_SIZE (default 4), SERVICE_MS (default 20), PORT (default 8000).
"""

import asyncio
import os

import uvicorn
from fastapi import FastAPI

POOL_SIZE = int(os.environ.get("POOL_SIZE", "4"))
SERVICE_MS = float(os.environ.get("SERVICE_MS", "20"))
PORT = int(os.environ.get("PORT", "8000"))

app = FastAPI(title="week-01-performance")
pool = asyncio.Semaphore(POOL_SIZE)
stats: dict[str, int] = {"in_flight": 0, "waiting": 0, "served": 0}


@app.get("/query")
async def query() -> dict[str, bool]:
    stats["waiting"] += 1
    async with pool:
        stats["waiting"] -= 1
        stats["in_flight"] += 1
        try:
            await asyncio.sleep(SERVICE_MS / 1000)
        finally:
            stats["in_flight"] -= 1
            stats["served"] += 1
    return {"ok": True}


@app.get("/stats")
async def get_stats() -> dict[str, int | float]:
    return {**stats, "pool_size": POOL_SIZE, "service_ms": SERVICE_MS}


if __name__ == "__main__":
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=PORT,
        workers=1,  # one event loop on purpose: the experiment measures its ceiling
        loop="uvloop",
        http="httptools",
        access_log=False,
        log_level="warning",
    )
