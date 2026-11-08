# MEV Arena: web UI (`apps/web`)

> **Simulation only.** No real assets, wallets or transactions; nothing here is investment advice (spec §17).
> The UI shows this as a banner on every screen.

The week-4 real-time UI: one page with the AMM price chart, the live mempool, the latest block's
transactions in execution order (sandwiches linked), P&L per bot and per account, victim slippage, and
Pause / Resume / Step / Replay controls. Next.js (App Router), TypeScript (strict), and Tailwind. The chart is
hand-written SVG, so there is no chart library.

## Run it

Needs Node 20.19+ (`nvm use 20`).

```bash
cd apps/web
npm install
npm run dev            # http://localhost:3000, mock mode (see .env.development)
```

| Command | What it does |
|---|---|
| `npm run dev` | dev server with hot reload |
| `npm test` | unit tests (vitest): reducer, mock AMM/builder/simulation, stream reconnects |
| `npm run lint` | ESLint (Next.js core-web-vitals + TypeScript rules) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` / `npm start` | production build / serve it |

### Mock or real gateway

`lib/stream.ts` is the only place that chooses. It reads two variables:

| Variable | Default | Meaning |
|---|---|---|
| `NEXT_PUBLIC_MOCK` | `1` in `.env.development` | `1`: run the in-browser mock simulation. Anything else: connect to the gateway |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8000` | Gateway base URL; the stream is `ws(s)://…/v1/stream` |

- Real gateway in dev: `NEXT_PUBLIC_MOCK=0 npm run dev` (a shell variable beats the `.env` file).
- `next build` does **not** read `.env.development`, so a production build talks to the real gateway unless
  you build with `NEXT_PUBLIC_MOCK=1 npm run build`.
- `NEXT_PUBLIC_*` values are compiled into the browser bundle. Restart `npm run dev` after changing them, and
  never put a secret in one.
- `.env.development` is committed on purpose: it holds only these public defaults. `apps/web/.gitignore`
  re-includes it, because the root `.gitignore` ignores every `.env.*`.

With no gateway running and `NEXT_PUBLIC_MOCK=0`, the header shows `live stream · reconnecting in … (attempt N)`
and the controls stay disabled. That is the expected behavior.

## Where things are

```
lib/contract.ts     THE wire contract: every frame, event payload and REST shape, plus parse helpers
lib/stream.ts       mock-or-real switch; connect(onFrame, onStatus) with reconnect + backoff; api.{pause,resume,step,replay}
lib/live.ts         real gateway: WebSocket + fetch
lib/transport.ts    the interface both backends implement
lib/reducer.ts      the single pure reducer: (state, frame) -> state
lib/derive.ts       P&L, slippage stats, sandwich detection, run summaries (pure)
lib/format.ts       BigInt -> display strings (ETH 4 dp, USDC 2 dp); the only float conversion
lib/mock/           the mock "server": sim.ts (world + mempool + bots + builder), runner.ts (timers),
                    amm.ts, execution.ts, builder.ts, bots.ts, rng.ts
components/         Arena (root, client), Header, PriceChart, MempoolPanel, BlocksPanel, PnlPanel, ui
tests/              vitest
```

Data flow: backend (mock or real) → JSON text frames → `parseFrame` (checks the contract) → `reduce` →
React state → panels. The mock serializes its frames to JSON as well, so mock frames go through exactly the
same parsing as real ones.

## The contract (`lib/contract.ts`)

- The stream is `GET /v1/stream`. It sends a `snapshot` first on every connect, then `event` frames (the spec §11
  envelope), plus `simulation` frames whenever `SimulationState` changes. REST: `POST
  /v1/simulation/{pause,resume,step,replay}` → `SimulationState`.
- The stream starts with a snapshot, instead of the client doing a REST GET and then subscribing, because
  anything that happened between the GET and the subscribe would be lost. The reducer drops the possible overlap.
- JSON is camelCase. Token amounts, the priority fee and fixed-point prices are **decimal strings** in minimal
  units (1e18 per token). Parse them with `toBigInt`; floats appear only in the chart's geometry.
- On reconnect or replay, the new snapshot **replaces** all state. Nothing is merged.

## Mock-only

- **The whole `lib/mock/` folder.** It is a stand-in that follows the Python engine's rules closely but not
  exactly. It covers Uniswap-v2 fee-on-input math, nonce-queue block building (ADR-0011), revert-style execution
  (ADR-0007) and the expiry rule (ADR-0010). The AMM math matches the engine to the unit (selling 10 ETH into
  1,000 / 1,000,000 at 30 bps gives 9,871 USDC, the same as `test_amm.py`).
- **The bots.** 20 noise traders, 1 arbitrage bot and 1 sandwich bot. Seed 42 by default, block every 3 s, capacity 12.
  Same seed + policy ⇒ same transactions, blocks and state roots.
- **`ADVERSARIAL` is a placeholder.** It takes the FIFO block, then moves each sandwich front to just before
  its victim and the back to just after. ADR-0011 leaves the real definition open.
- **`Market.referencePrice` / `MarketPriceUpdated.referencePrice`.** These carry the arb bot's random-walk
  target and draw the reference line on the chart. If the gateway leaves them out, the line disappears.
- **State roots** are a 64-hex FNV hash, not sha256. They never match the engine's.
- **Event ids** are deterministic UUID-shaped strings.
- **The mempool** rejects with `pool_full` instead of evicting the cheapest transaction (ADR-0009), because the
  contract has no eviction event yet.
- **The "drop connection" button** in the header exists only in mock mode. It cuts the stream so you can
  watch the reconnect and the snapshot rebuild.

## When the real gateway lands

1. Replace the TYPES section of `lib/contract.ts` with types generated from FastAPI's OpenAPI schema (for
   example `openapi-typescript`), keeping the names. The HELPERS section stays. A generated runtime validator
   can replace the light checks in `parseFrame`.
2. Have the gateway emit exactly the frames listed there. The two **UI-draft additions** are
   `AccountInfo.baseBalance` / `quoteBalance`, the balances at snapshot time. Without them, P&L after a
   reconnect would be wrong once the height exceeds the snapshot's block window.
3. Run with `NEXT_PUBLIC_MOCK=0`. Allow the UI's origin in the gateway's CORS settings for the REST calls. The
   WebSocket connects straight to `NEXT_PUBLIC_API_URL`, with no proxy.
4. Optionally delete `lib/mock/` and the mock branch in `lib/stream.ts`. Nothing else imports the mock.

Open contract points for the gateway (the UI works around each today):

- There is no event for a transaction that leaves the mempool without executing. On expiry, the reducer applies
  the ADR-0010 rule itself at every `BlockCommitted`. Replacement is handled by dropping any older
  transaction with the same `(accountId, nonce)`. Eviction from a full pool (ADR-0009) is invisible until
  the next snapshot. A `TransactionDropped {transactionId, reason}` event would close this gap.
- There is no sequence number on frames. Overlap between the snapshot and the first events is detected by
  height (for block events) and by known transaction ids (for `TransactionAccepted`). A `seq` on every frame,
  plus the last `seq` included in the snapshot, would make this exact.
- After a replay, the gateway should send a fresh `snapshot` on every open stream. The mock does.
- `nextBlockAt` is server time, so the countdown is off by any clock skew between server and browser.
- The chart's price history after a (re)connect is rebuilt by undoing the receipts in `recentBlocks`. That
  assumes one market, since receipts carry no `marketId`. The mock-only reference line starts at the snapshot.
