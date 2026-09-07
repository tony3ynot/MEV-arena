"""Sample GET /stats once per second and print in_flight, waiting, and served rate.

Usage: python stats_sampler.py [http://127.0.0.1:8000/stats]   (Ctrl-C to stop)
Run it next to a k6 run to see where requests wait: on the pool (waiting grows) or elsewhere.
"""

import json
import sys
import time
import urllib.request

url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000/stats"
prev_served: int | None = None
prev_t = 0.0
t0 = time.monotonic()
print("t_s\tin_flight\twaiting\tserved_per_s", flush=True)
while True:
    t = time.monotonic()
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            d = json.load(r)
        served = int(d["served"])
        rate = "" if prev_served is None else f"{(served - prev_served) / (t - prev_t):.0f}"
        print(f"{t - t0:.0f}\t{d['in_flight']}\t{d['waiting']}\t{rate}", flush=True)
        prev_served, prev_t = served, t
    except Exception as e:  # the server may be busy; keep sampling
        print(f"{t - t0:.0f}\terr\t{e}", flush=True)
    time.sleep(max(0.0, 1.0 - (time.monotonic() - t)))
