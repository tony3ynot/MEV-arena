// k6 open-model load for the week-01 experiment. See README.md.
//
// One scenario per stage, each a constant-arrival-rate executor. Scenarios are spaced STAGE_S + COOLDOWN_S
// apart so every stage starts from an empty server queue. Each scenario pre-allocates its worst-case VU need
// (every request held until the timeout: rate x timeout, Little's law again), capped at MAX_VUS. When the cap
// binds, k6 reports dropped_iterations for that scenario and the stage is invalid.
//
// Run:  k6 run --summary-mode=full -e POOL_SIZE=4 -e SERVICE_MS=20 load-test.js
// Env:  POOL_SIZE, SERVICE_MS   capacity C = POOL_SIZE / SERVICE_MS
//       CAPACITY                override C (control run: -e CAPACITY=2500)
//       STAGE_S=20 COOLDOWN_S=10 MAX_VUS=2000 TIMEOUT_S=2 BASE_URL=http://127.0.0.1:8000

import http from "k6/http";
import { check } from "k6";

const POOL_SIZE = Number(__ENV.POOL_SIZE ?? 4);
const SERVICE_MS = Number(__ENV.SERVICE_MS ?? 20);
const CAPACITY = Number(__ENV.CAPACITY ?? POOL_SIZE / (SERVICE_MS / 1000));
const STAGE_S = Number(__ENV.STAGE_S ?? 20);
const COOLDOWN_S = Number(__ENV.COOLDOWN_S ?? 10);
const MAX_VUS = Number(__ENV.MAX_VUS ?? 2000);
const TIMEOUT_S = Number(__ENV.TIMEOUT_S ?? 2);
const BASE_URL = __ENV.BASE_URL ?? "http://127.0.0.1:8000";
const LEVELS = [0.5, 0.9, 1.1, 1.5];

// Guard: a huge pool with no CAPACITY override means C = POOL_SIZE / S is meaningless (the control run needs
// -e CAPACITY=<guess>). Fail fast instead of scheduling millions of requests per second.
if (CAPACITY > 50000 && !__ENV.FORCE) {
  throw new Error(
    `CAPACITY=${CAPACITY} req/s looks wrong. For the control run pass -e CAPACITY=<loop guess>; use -e FORCE=1 to override.`,
  );
}

function stage(index, mult) {
  const rate = Math.max(1, Math.round(CAPACITY * mult));
  const worstCaseVus = Math.min(MAX_VUS, Math.ceil(rate * TIMEOUT_S * 1.1) + 10);
  return {
    executor: "constant-arrival-rate",
    rate,
    timeUnit: "1s",
    duration: `${STAGE_S}s`,
    startTime: `${index * (STAGE_S + COOLDOWN_S)}s`,
    preAllocatedVUs: worstCaseVus,
    maxVUs: worstCaseVus,
    gracefulStop: `${TIMEOUT_S + 1}s`,
    tags: { stage: `${mult}C`, rate: String(rate) },
  };
}

export const options = {
  scenarios: Object.fromEntries(
    LEVELS.map((m, i) => [`stage_${String(Math.round(m * 100)).padStart(3, "0")}C`, stage(i, m)]),
  ),
  discardResponseBodies: true,
  summaryTrendStats: ["avg", "p(50)", "p(95)", "p(99)", "max"],
  summaryTimeUnit: "ms",
};

export function setup() {
  const rates = LEVELS.map((m) => Math.round(CAPACITY * m)).join(" / ");
  console.log(
    `C=${CAPACITY} req/s  stages=${rates}  stage=${STAGE_S}s cooldown=${COOLDOWN_S}s  ` +
      `timeout=${TIMEOUT_S}s maxVUs=${MAX_VUS}  target=${BASE_URL}`,
  );
}

export default function () {
  const res = http.get(`${BASE_URL}/query`, { timeout: `${TIMEOUT_S}s` });
  check(res, { "status 200": (r) => r.status === 200 });
}
