# Swadesh CC — multi-tenant contact-centre platform

A full-stack reference implementation of the product described in the *Full Stack Engineer (React + Node.js)* job description:
an **admin console**, an **agent workspace**, a **dialer** (preview / progressive / predictive), **call queues**, **live wallboards over raw WebSockets**,
**structured reports**, a **public SMS + voice API** (keys, scopes, rate limits, signed webhooks) and **privacy tooling**
(recording consent, hard pause/resume tokens, retention, erasure, exports) — all on a strictly **multi-tenant** MySQL + MongoDB data layer.

> **Telephony is simulated.** There is no carrier or media server. A demo engine generates inbound calls, dials leads, and plays "bot" agents so every screen has
> live, believable data. The UI says so (banner) and anything that genuinely needs media (listen / whisper / barge) is shown as *not available*, with the reason.

## Run it

Requires Node 20+. **No database install needed** — with no `MYSQL_URL`/`MONGO_URL` set, the API boots embedded MySQL 8 + MongoDB, migrates and seeds
(first run downloads the binaries, ~1–2 min; afterwards ~20 s). Data is ephemeral in this mode.

```bash
npm install
npm run dev:all        # API on :4000 (+ /ws), web on http://localhost:5173
```

Open <http://localhost:5173> and use the one-click demo buttons on the login page (password for every user: `Demo@1234`).

| Tenant | Admin | Supervisor | Agent (human, you) |
|---|---|---|---|
| Aarav Insurance Services (30k calls) | admin@aarav.test | supervisor@aarav.test | agent@aarav.test |
| Zenith Collections (12k calls) | admin@zenith.test | supervisor@zenith.test | agent@zenith.test |
| Kaveri Healthcare (6k calls, recordings expire at 30 days) | admin@kaveri.test | supervisor@kaveri.test | agent@kaveri.test |

Other agents (e.g. *Amit Deshmukh*) are simulated bots. Try this:

1. Sign in as **agent@aarav.test** → *Available* → **Simulate an incoming call** → Answer → *Pause recording* (note the one-time token) → *Resume* → End → pick a disposition.
2. In another window sign in as **supervisor@aarav.test**: watch the wallboard, agent map and queue counts move in real time.
3. **admin@aarav.test** → *Developer* → *API reference & try-it* with the seeded key `swk_live_aarav_demo_7f3a9c1e5b2d4068a1f8` (same pattern for `zenith` / `kaveri`: see `server/src/db/seed.ts`).
4. Sign in to *Zenith* and confirm none of Aarav's data is visible anywhere.

### With real databases (Docker)

```bash
docker compose up -d
cp server/.env.example server/.env
npm run seed          # or: npm run seed:scale   (≈150k / 80k / 20k calls)
npm run dev:all
```

`npm run dev:scale` boots the embedded databases with the large dataset.

## What maps to the job description

| JD requirement | Where |
|---|---|
| React + TypeScript, accessible screens, admin console **and** agent workspace | `web/src/pages/admin/*`, `web/src/pages/agent/Workspace.tsx` (landmarks, skip link, focus-trapped dialogs, `aria-live`, state = icon + text + colour) |
| Node.js + TypeScript REST APIs | `server/src/routes/*` (Express, zod validation, uniform error shape) |
| Dialer rules, campaigns, queue strategies | `server/src/engine/runtime.ts` — preview/progressive/predictive pacing, abandon-rate throttle, DNC, attempt limits, per-campaign rule engine; strategies: longest-idle, round-robin, least-calls, skills-based, ring-all |
| Structural reports & live dashboards | `server/src/services/reports.ts`, `web/src/pages/admin/Reports.tsx`, `Wallboard.tsx` (recharts) |
| Real-time over **raw WebSockets** | `server/src/engine/hub.ts` + `web/src/lib/live.tsx` — token-in-first-message auth, per-tenant fan-out, sequence numbers, gap-triggered resync, heartbeat, reconnect with backoff, honest "stale data" indicator |
| MySQL **and** MongoDB, indexes, multi-tenant isolation | MySQL: relational/transactional (`server/src/db/migrations`). MongoDB: high-volume event streams (`call_events`, `agent_state_log`, `wallboard_snapshots`, `audit_log`). Every index leads with `company_id`. |
| SMS & voice APIs, webhooks, API keys, strict rate limits | `server/src/routes/v1.ts`, `middleware/apiKeyAuth.ts`, `middleware/rateLimit.ts`, `services/webhooks.ts` |
| Privacy: consent prompts, hard pause/resume tokens, retention/deletion, exports | `server/src/services/privacy.ts`, `web/src/pages/admin/Privacy.tsx` |
| **Multi-tenant rigor** | see below |
| **Truthful interfaces** | `Unavailable` component, simulation banner, connection chip, disabled actions that state why, no optimistic fake success |
| **Scale testing** | `npm run seed:scale` + the numbers below + an `EXPLAIN` test that fails on any full scan |
| Migrations & safe rollout | forward-only, ordered, idempotent SQL migrations tracked in `schema_migrations` (`db/migrate.ts`) |

## Multi-tenant rigor — how it is enforced

* The tenant (`companyId`) comes **only** from the verified JWT or the API key row — never from a path, query or body.
* Request handlers get no raw DB handle. `tdb(companyId)` (`lib/tenant.ts`) refuses any statement that doesn't mention `company_id` **and** doesn't bind the caller's tenant id. Mongo uses `mcol(name, companyId)`, which merges `company_id` into every filter and insert.
* Foreign references in writes are validated (a queue member, a campaign's queue …must belong to the caller's tenant).
* The only cross-tenant code paths are the webhook-delivery and retention workers, which process each row strictly with *its own* `company_id`; login and API-key lookup are the two pre-tenant credential lookups.
* `server/src/tests/integration.test.ts` attacks tenant A → B on every id-addressed route, list, report, export and the public API, and checks that erasure / retention in one tenant leave the same phone number in another tenant untouched.

## Real-time design

```
agent / dialer timers ─▶ TenantRuntime (serialised per tenant) ─▶ hub.broadcast(companyId, {seq, type, …})
                                                                      │  raw ws, JWT auth in first frame
 React LiveProvider ◀── agent.state · queue.counts · call.update · call.end · stats · hb ◀──┘
        └─ seq gap ⇒ {type:'resync'} ⇒ fresh snapshot;  socket drop ⇒ backoff + "stale" banner
```

Per-tenant state lives in memory for speed and is rebuilt from MySQL on boot (in-flight leads/calls from a crash are reset). Call lifecycle is persisted to MySQL; timelines/telemetry stream to MongoDB in batches.

## Privacy features

* **Consent per queue**: none / *announce* (prompt logged) / *opt-in* (declines are never recorded). Every step is a `consent_events` row.
* **Hard pause/resume**: pausing issues a one-time token (shown once, stored hashed). Nothing — not the UI, not a timer — resumes recording without it. Wrong token = denied + audited. A supervisor can force-resume, recorded as `pause_override`.
* **Retention**: per-company days for recordings / call records / SMS; preview of what would be purged; chunked (5,000-row) deletes; runs every 6 h or on demand.
* **Erasure by phone number**: calls are anonymised (numbers/notes/recording refs removed so reports stay correct), SMS + leads + event timelines deleted, number added to DNC, evidence kept as masked counts only.
* **Exports**: async, keyset-paginated CSV (calls / SMS / consent / data-subject access), formula-injection safe, every request and download audited.

## Public API (`/v1`)

`Authorization: Bearer swk_live_…` — per-key scopes (`sms:send sms:read calls:write calls:read`), sliding-window rate limit per key
(`X-RateLimit-*`, `429` + `Retry-After`), `Idempotency-Key` on POSTs, DNC enforcement, cursor pagination.

```bash
curl -X POST http://localhost:4000/v1/sms \
  -H "Authorization: Bearer swk_live_aarav_demo_7f3a9c1e5b2d4068a1f8" \
  -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" \
  -d '{"to":"+919876543210","body":"Your renewal is due on 12 Oct."}'
```

Webhooks are signed `X-Swadesh-Signature: t=<unix>,v1=<hmac_sha256(secret, "t.body")>`, retried 5× (5 s, 30 s, 2 m, 10 m, 1 h), visible in *Developer → Delivery log* with manual retry. In dev, seeded webhooks point at a built-in verifying sink (`/dev/webhook-sink/<slug>`; `/dev/webhook-sink/fail` always returns 500 to demonstrate backoff). In production webhook URLs must be public https (SSRF guard).

## Tests

```bash
npm test          # 20 tests: unit + integration against real embedded MySQL/Mongo
npm run typecheck
```

## Scale check (embedded MySQL on a laptop, `seed:scale` = 150,000 calls for the largest tenant)

| Endpoint | Time |
|---|---|
| Call log, page 1 / page 4,000 (deferred-join pagination) | 35 ms / 102 ms |
| Call log, 3 filters | 271 ms |
| 7-day overview | 63 ms |
| 120-day overview / queues / agents / campaigns report | 0.35 – 0.55 s |

Techniques: tenant-leading composite indexes, no per-row joins in aggregates, deferred-join pagination, keyset pagination for exports, chunked purges, `FOR UPDATE SKIP LOCKED` lead claiming.

## Known limits (deliberately honest)

* No real PSTN/SMS carrier and no audio: "recordings" are metadata (consent state, key, retention), not media.
* Rate limiter and idempotency cache are in-memory (single node). Interfaces are isolated so Redis can replace them; the runtime engine is also single-process per deployment.
* Demo override: the campaign calling-window check is disabled while simulating so the dialer works at any hour (stated on the campaign screen).
* Embedded databases are ephemeral and for development only; use Docker/managed MySQL + MongoDB otherwise.
* Auth is email + password with 12 h JWTs kept in `localStorage` (fine for a demo; use httpOnly cookies + refresh rotation + MFA for production). No password reset flow.

## Layout

```
server/src  config · boot · app · index
  db/        mysql · mongo · embedded · migrate · migrations/*.sql · seed
  engine/    runtime (dialer, queues, call lifecycle) · hub (WebSocket)
  routes/    auth admin calls reports developer privacy agent v1 dev
  services/  reports privacy sms webhooks
  middleware auth apiKeyAuth rateLimit      lib  tenant errors audit crypto csv rng
  tests/     unit.test.ts integration.test.ts
web/src     pages/admin/* pages/agent/* components/ lib/ (api · auth · live WS client)
```
