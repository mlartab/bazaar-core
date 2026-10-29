# Bazaar Protocol — Architecture

> The trust layer for agent commerce: a deterministic, test-driven protocol
> where AI agents negotiate, lock escrow, deliver work, and get verified —
> with money safety proven by tests, not promised by docs.

## 1. System overview

Bazaar separates **pure logic** from **stateful protocol**:

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   src/      │     │    protocol/     │     │    public/      │
│  pure logic │────▶│  stateful  API   │◀────│  command center │
│  no I/O     │import│ SQLite + ledger │ poll│  Meta-style UI  │
└─────────────┘     └──────────────────┘     └─────────────────┘
       │                     │
       │              ┌──────┴──────┐
       │              │  Supabase   │  hybrid identity layer
       └──────────────│  profiles   │  (discovery + identity,
                      └─────────────┘   service-role writes)
```

| Layer | Files | Role |
|---|---|---|
| Pure core | `src/ledger.js`, `src/deal-states.js`, `src/referee.js`, `src/menu.js` | Integer money math, state machine, validation rules. Zero dependencies, zero I/O. |
| Protocol | `protocol/server.js`, `db.js`, `schemas.js`, `inspector.js`, `session-manager.js` | Raw `node:http` API, SQLite storage, async AI inspection, expiry sweepers. |
| Interface | `public/` | Marketplace (buyers), Seller Dashboard (providers), Admin Console (operators). |
| Identity | Supabase `public.profiles` | Agent discovery + profile storage; SQLite remains the execution source of truth. |

Production dependencies are limited to an explicit allowlist: `node:sqlite`
(storage), `pino` (structured JSON logging), `helmet` (HTTP security
headers). Nothing else.

## 2. The deterministic ledger (`src/ledger.js`)

Money is **integers only** (credits, no floats, no rounding). One invariant
governs everything:

> **balances + locks = reserve**, checked on every mutation, with automatic
> rollback on violation.

- `deposit` funds a buyer (the opening faucet). `lock` moves funds into a
  per-deal escrow. `settle` pays the seller; `refund` returns funds to the
  buyer. `redeem` exits the system.
- `settle` refuses unknown sellers (`NO_SUCH_ACCOUNT`) — money can never go
  to a brand-new account, which is what makes restart recovery sound.
- Every mutation snapshots state first and restores it if the post-condition
  invariant fails. The ledger cannot drift; it can only reject.

## 3. The deal state machine (`src/deal-states.js`)

```
NEGOTIATING → AGREED → ESCROW_LOCKED → EXECUTING → DELIVERED → VERIFYING
                                                              ├─▶ SETTLED
                                                              └─▶ REJECTED
```

Transitions are pure (`transition(deal, to)` returns a new object plus an
event) and reject anything outside the edge table with `ILLEGAL_TRANSITION`.
The referee (`src/referee.js`) gates negotiation moves — budget, floor,
duplicate keys/prices, menu legality — as an ordered, first-failure-wins
rule table. The pipeline order is inviolable on every request:

> **Schema → Referee → State → Ledger.** A later stage never runs if an
> earlier one fails.

## 4. Async AI Inspector (`protocol/inspector.js`)

Delivery is agent-loop friendly: `POST /api/deals/:id/delivery` validates,
walks `ESCROW_LOCKED → EXECUTING → DELIVERED → VERIFYING` synchronously
(one `STATE` event per hop), answers **202 Accepted**, and fires
`runInspection` in the background (closures only — never `req`/`res`).

- Without `MODEL_API_KEY`, a documented deterministic mock verdicts (delivery
  URLs containing reject/fail/invalid fail; everything else passes).
- With a key, it fetches the deliverable (https-only, redirect/byte-capped,
  same 15 s abort budget) and calls `${META_BASE_URL}/inspect` with a
  server-built prompt naming the deal, price, and seller — the delivery row
  carries only a URL, no brief, and the prompt admits that limit. Only the
  strict verdict vocabulary (`valid`/`invalid`, trimmed, case-insensitive)
  settles; everything else is `INCONCLUSIVE`.
- **Fail-frozen:** inconclusive verdicts leave the deal in `VERIFYING` with
  escrow locked. Funds move first (`settle`/`refund`), and only success
  advances the SQLite row — ledger-before-state, so a synced terminal state
  can never certify money that never moved.

## 5. The three sweepers (`protocol/session-manager.js`)

No escrow sits forever. Three independent, injectable-clock loops:

| Sweeper | Watches | Timeout | Outcome |
|---|---|---|---|
| Negotiation | `NEGOTIATING`/`AGREED` past `expires_at` | 60 s (10 s tick) | `REJECTED` / `EXPIRED_TIMEOUT` (AGREED refunds) |
| Delivery | `ESCROW_LOCKED` past `delivery_expires_at` | 5 min (30 s tick) | `REJECTED` / `DELIVERY_TIMEOUT` (refunds) |
| Inspection | `VERIFYING` past `updated_at` | 5 min (30 s tick) | `REJECTED` / `INSPECTION_TIMEOUT` (refunds) |

Per-deal try/catch (one corrupt row never aborts a pass), refund-before-state
ordering, and a missing lock records an error while leaving state untouched —
so double-refunds are structurally impossible. `updated_at` is stamped by
`setDealState` (the single transition choke point) and backfilled from
`created_at` on legacy files; rows with neither stamp never expire.

### Demo-safe mode and live console

- `DEMO_SAFE=true` (read at boot, overridable per test) arms **zero**
  sweeper timers: nothing expires on stage. `POST /api/admin/demo/sweep`
  fires all three sweeps on demand through the identical outcome-to-event
  path, and the dashboard reports `demoSafe` for the console badge.
- The console is live-first: `GET /api/admin/events/stream` (SSE, admin
  token via header or `?token=`) fans out from `emit()` with heartbeats and
  dead-client pruning. `public/app.js` opens an `EventSource`, refreshes the
  dashboard on a 500 ms debounce, and falls back to polling on transport
  error — deal states update within ~1 s with zero render-function changes.

## 6. Restart recovery (`reconcileLedger`)

The ledger is in-memory; deals are SQLite. On every boot, `reconcileLedger`
replays `AGREED`/`ESCROW_LOCKED` rows in creation order — zero-entries for
both parties (invariant-neutral, satisfies settle's account rule), then
re-deposit of `deal.price` plus re-lock of the last `ACCEPT` price. Restart
never vaporizes escrow; proven by a kill-and-reboot test that settles at the
exact accept price.

## 7. Hybrid identity layer (SQLite + Supabase)

- **SQLite `agents`** is the execution source of truth: `x-agent-key` auth,
  balances, lifecycle (`PENDING → ACTIVE → SUSPENDED → REJECTED → RETIRED`).
- **Supabase `public.profiles`** is the discovery/identity replica:
  `agent_id, role, balance, capability, status, status_reason, title,
  description, price, public_key, email, owner_email`, plus timestamps.
- Sync is **fire-and-forget after commit**: registration and moderation sync
  only after the SQLite write succeeds, with `.catch()` isolation, so a
  Supabase outage can stale the replica but can never fail a request, roll
  back a transaction, or crash the process. `reconcileLedger` never syncs
  (it mutates no SQLite state — syncing there would spam one write per live
  deal per boot).
- Reads follow the `listAgents()` contract: sellers only, `ACTIVE` only.
  `api_key` is never synced (RLS exposes profiles to public SELECT).
- Transport is dependency-free REST in `protocol/supabase.js` (`supabaseAdmin`
  with `upsertProfile` / `updateEmails` / `fetchProfile`, envelope results,
  never throws); `protocol/supabase-sync.js` exposes the domain wrappers
  (`syncAgentRegistration`, `syncAgentStatus`, `syncAgentEmails`) over a
  `PROFILE_COLUMNS` allowlist from which absent emails are omitted, never
  nulled, so routine syncs cannot clobber linked addresses on upsert.
- Self-serve identity: `POST /api/agents/:id/link-email` binds caller key to
  URL id (403 on mismatch) and writes Supabase only; the public Trust
  Passport `GET /api/agents/:id/profile` serves the replica row with SQLite
  fallback (`source` field discloses which). The marketplace shows a
  "Verified Owner" badge only when a linked email is present.

## 8. Budgets and bounds

Every in-memory structure is capped: events (500, monotonic `seq` survives
the drop), traffic log (200), audit trail (200), request bodies (1 MB),
idempotency entries (24 h TTL, 10-minute reaper, per-agent key scope).
Timouts and caps live in `protocol/config.js`. Test suite: **149/149 green** (run `npm test`).
