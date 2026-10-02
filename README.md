# Swadesh CC — multi-tenant contact-centre platform

A full-stack reference implementation of the product described in the *Full Stack Engineer (React + Node.js)* job description:
an **admin console**, an **agent workspace**, a **dialer** (preview / progressive / predictive), **call queues**, **live wallboards over raw WebSockets**,
**structured reports**, a **public SMS + voice API** (keys, scopes, rate limits, signed webhooks) and **privacy tooling**
(recording consent, hard pause/resume tokens, retention, erasure, exports) — all on a strictly **multi-tenant** MySQL + MongoDB data layer.

> **Telephony is simulated.** There is no carrier or media server. A demo engine generates inbound calls, dials leads, and plays "bot" agents so every screen has
> live, believable data. The UI says so (banner) and anything that genuinely needs media (listen / whisper / barge) is shown as *not available*, with the reason.

> **New here? Read the [User Manual](docs/USER-MANUAL.md)** — what each role can do and exactly where to do it, plus API, privacy and troubleshooting guides.

## Run it

Requires Node 20+. **No database install needed** — with no `MYSQL_URL`/`MONGO_URL` set, the API boots embedded MySQL 8 + MongoDB, migrates and seeds
(first run downloads the binaries, ~1–2 min; afterwards ~20 s). Data is ephemeral in this mode.

**Windows one-click:** double-click `Start-Demo.bat` (stops any old copy, starts everything, opens Chrome and Edge on **http://localhost:4000** when ready; `Stop-Demo.bat` stops it).

Or from a terminal:

```bash
npm install
npm run dev:all        # API on :4000 (+ /ws), web on http://localhost:5173
```

Open <http://localhost:5173>, pick a company, then click **Sign in as Admin** or **Sign in as Normal user** (password for every demo login: `Demo@1234`).

| Company | Admin | Normal user | Supervisor (read-only monitoring) |
|---|---|---|---|
| Aarav Insurance Services (30k calls) | `admin@aarav.test` | `user@aarav.test` | `supervisor@aarav.test` |
| Zenith Collections (12k calls) | `admin@zenith.test` | `user@zenith.test` | `supervisor@zenith.test` |
| Kaveri Healthcare (6k calls, recordings expire at 30 days) | `admin@kaveri.test` | `user@kaveri.test` | `supervisor@kaveri.test` |

### Two roles, built for many people at once

* **Admin** — the whole console: live wallboard, queues, campaigns & dialer rules, reports, API keys & webhooks, privacy tools, audit log and the **Platform showcase**.
* **Normal user** — the agent workspace. This is a *shared* login, but **every sign-in gets its own private agent seat** (own state machine, calls, history and WebSocket channel). Ten people can be "Normal user" at once and never see or disturb each other; seats are reclaimed on sign-out or after 10 idle minutes, and if a company's seats (25) are all taken you are told so instead of sharing someone's session.
* Several admins can work simultaneously too: queue and campaign edits use **optimistic locking**, so if two admins edit the same record the second save is rejected ("someone else changed this") rather than silently overwriting.

Other agents (e.g. *Amit Deshmukh*) are simulated bots.

## Presenting it: how to show each JD requirement live

Sign in as **Admin**, open **Platform showcase** (left nav). Every number on it is measured from the running system.

| JD says | Show | Where |
|---|---|---|
| Node.js + TypeScript production APIs | Node version, memory, event-loop lag, per-route p50/p95/p99, requests/s | Showcase → *Node.js API* |
| Real-time with raw WebSockets | Live frame tap (type, seq, bytes), frames/s, who is connected. Click **Cut the connection for 8 s**: the header chip turns to *"Reconnecting — data may be stale"*, then it reconnects and resyncs | Showcase → *WebSockets* |
| React + TypeScript, heavy client | React version, Profiler commits/avg render time while frames stream in; the wallboard and agent map updating without reloads | Showcase → *React*; Wallboard; Agents |
| MySQL + MongoDB, indexes, 100k+ rows | Row counts per store, **Run benchmarks** (ms + the index chosen by `EXPLAIN`), **Start load test** (from the server or the browser; p50/p95/p99, errors) | Showcase → *Heavy-data backend* |
| Multi-tenant rigor | **Run isolation probes**: tries to read other companies' rows through the data layer and shows each attempt rejected; sign in as Zenith and see none of Aarav's data | Showcase → *Multi-tenant*; Login |
| Truthful interfaces | The real / simulated / unavailable register, the disabled *Listen · Whisper · Barge* control with its reason, the simulation banner, stale-data chip | Showcase → *Truthful UI*; Agents |
| Dialer rules, queue strategies, campaigns | Start/pause a campaign, edit rules, watch predictive pacing throttle to 1:1 at the abandon cap | Campaigns → campaign detail; Wallboard |
| SMS & voice API, webhooks, API keys, rate limits | Create a key, **API reference & try-it** (watch `X-RateLimit-*` and the `429`), webhook delivery log with retries | Developer |
| Privacy & compliance | As *Normal user*: Simulate an incoming call → Pause recording (one-time token) → Resume; then Privacy → consent log, retention preview, erasure, exports | Agent workspace; Privacy |
| Many users, no collisions | Open a second browser/private window as *Normal user*; watch *Who is connected* gain a seat and see that changing its status moves only its own card | Showcase → *WebSockets*; Agents |

Quick 3-minute path: Login → Wallboard (live) → Agent workspace in a second window (simulate a call, pause recording) → Showcase (cut the connection, run benchmarks, load test, isolation probes) → Developer try-it (hit the rate limit).

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
| **Truthful interfaces** | `Unavailable` component, simulation banner, connection chip, disabled actions that state why, capability register (`/api/system/capabilities`), no optimistic fake success |
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
npm test          # 30 tests: unit + integration + concurrency, against real embedded MySQL/Mongo
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
* The shared Normal User / Admin logins are demo conveniences. In production each person has a named account (the guest-seat mechanism then simply isn't used); with a shared Admin login the audit log cannot tell people apart.
* `/api/system/*` (Platform showcase) is available to any company's admin and only exposes that company's traffic plus process-level gauges; in production restrict it to platform operators.
* Embedded databases are ephemeral and for development only; use Docker/managed MySQL + MongoDB otherwise.
* Auth is email + password with 12 h JWTs kept in `localStorage` (fine for a demo; use httpOnly cookies + refresh rotation + MFA for production). No password reset flow.

## Layout

```
server/src  config · boot · app · index
  db/        mysql · mongo · embedded · migrate · migrations/*.sql · seed
  engine/    runtime (dialer, queues, call lifecycle) · hub (WebSocket)
  routes/    auth admin calls reports developer privacy agent system v1 dev
  services/  reports privacy sms webhooks sessions (guest seats)
  middleware auth apiKeyAuth rateLimit      lib  tenant errors audit crypto csv rng metrics
  tests/     unit.test.ts integration.test.ts concurrency.test.ts
web/src     pages/admin/* pages/agent/* components/ lib/ (api · auth · live WS client)
```
