// k6 open-model producers for the week-03 experiment. See README.md.
//
// One constant-arrival-rate scenario per stage, at multiples of the consumer's nominal capacity C. Stages are
// spaced STAGE_S + COOLDOWN_S apart so the block producer can drain what the previous stage left behind.
// Each submission is a fresh transaction with a uniform random fee in [0, 100).
//
// 429 is an expected answer (the pool said "full"), not a failure; http_req_failed counts only timeouts and
// errors. The "stored 202" check rate is the admission rate per stage.
//
// Run:  k6 run --summary-mode=full -e MAX_SIZE=1000 load-test.js
// Env:  CAPACITY=400 (C = BLOCK_CAP / BLOCK_MS on the server)   MAX_SIZE (label only)
//       LEVELS=0.5,1.5,2.5 STAGE_S=30 COOLDOWN_S=30 MAX_VUS=6000 TIMEOUT_S=2 BASE_URL=http://127.0.0.1:8000

import http from "k6/http";
import exec from "k6/execution";
import { check } from "k6";

const CAPACITY = Number(__ENV.CAPACITY ?? 400);
const STAGE_S = Number(__ENV.STAGE_S ?? 30);
const COOLDOWN_S = Number(__ENV.COOLDOWN_S ?? 30);
const MAX_VUS = Number(__ENV.MAX_VUS ?? 6000);
const TIMEOUT_S = Number(__ENV.TIMEOUT_S ?? 2);
const BASE_URL = __ENV.BASE_URL ?? "http://127.0.0.1:8000";
const LEVELS = (__ENV.LEVELS ?? "0.5,1.5,2.5").split(",").map(Number);

http.setResponseCallback(http.expectedStatuses(202, 429));

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
    `MAX_SIZE=${__ENV.MAX_SIZE ?? "?"}  C=${CAPACITY} tx/s  stages=${rates}  stage=${STAGE_S}s ` +
      `cooldown=${COOLDOWN_S}s  timeout=${TIMEOUT_S}s maxVUs=${MAX_VUS}  target=${BASE_URL}`,
  );
}

const HEADERS = { headers: { "Content-Type": "application/json" }, timeout: `${TIMEOUT_S}s` };

export default function () {
  const id = `${exec.scenario.name}-${exec.scenario.iterationInTest}`;
  const fee = Math.floor(Math.random() * 100);
  const res = http.post(`${BASE_URL}/tx`, JSON.stringify({ id, fee }), HEADERS);
  check(res, {
    "stored 202": (r) => r.status === 202,
    "answered 202 or 429": (r) => r.status === 202 || r.status === 429,
  });
}
