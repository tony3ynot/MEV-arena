"""Sample GET /stats once per second: depth, rates, wait in pool, block build time, memory.

Usage: python stats_sampler.py [http://127.0.0.1:8000/stats]   (Ctrl-C to stop)
The server resets its interval figures on every call, so run exactly one sampler.
"""

import json
import sys
import time
import urllib.request

url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000/stats"
RATES = ("accepted", "pool_full", "evicted", "included")


def fmt(x: object, digits: int = 0) -> str:
    return "-" if x is None else f"{float(str(x)):.{digits}f}"


prev: dict[str, int] | None = None
prev_t = 0.0
t0 = time.monotonic()
print(
    "t_s\tdepth\tacc/s\tfull/s\tevict/s\tincl/s\twait_p50_s\twait_p99_s\tbuild_max_ms"
    "\tfee_in\tfee_shed\trss_mb",
    flush=True,
)
while True:
    t = time.monotonic()
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            d = json.load(r)
        rates = (
            ["-"] * len(RATES)
            if prev is None
            else [f"{(d[k] - prev[k]) / (t - prev_t):.0f}" for k in RATES]
        )
        row = [
            f"{t - t0:.0f}",
            str(d["depth"]),
            *rates,
            fmt(d["wait_p50_s"], 2),
            fmt(d["wait_p99_s"], 2),
            fmt(d["build_ms_max"], 1),
            fmt(d["included_fee_mean"]),
            fmt(d["shed_fee_mean"]),
            str(d["rss_mb"]),
        ]
        print("\t".join(row), flush=True)
        prev, prev_t = {k: int(d[k]) for k in RATES}, t
    except Exception as e:  # the server may be too busy to answer; keep sampling
        print(f"{t - t0:.0f}\terr\t{e}", flush=True)
    time.sleep(max(0.0, 1.0 - (time.monotonic() - t)))
