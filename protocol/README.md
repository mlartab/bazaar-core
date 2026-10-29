# protocol/ — Stateful API Wrapper

Bazaar's protocol layer. It wraps the pure logic in `src/` with storage
(SQLite), an HTTP API (`node:http`, no framework), and an in-memory ledger,
event log, and idempotency map. No AI calls live here yet; the delivery
route exposes a `fastValidateDelivery` seam where the async AI Inspector
will plug in.

## Separation of concerns

- `src/` is pure logic: integer ledger math, the deal state machine, and the
  referee rule table. No I/O, no server, no storage. It is imported, never
  modified, by this folder.
- `protocol/` is stateful: it owns the SQLite connection (`db.js`), the
  request schemas (`schemas.js`), and the HTTP server (`server.js`), which
  holds one ledger instance, one event list, and one idempotency map per
  process. SQLite runs in WAL mode with a 5s busy timeout, so readers
  proceed during writes and same-file contention waits instead of failing.

## Request pipeline

Every mutating request runs the same stages in this order. A stage that does
not apply to an endpoint passes through. The first failing stage wins and
its code is returned; later stages never run.

1. **Schema** (`schemas.js`): is the JSON body the right shape? Required
   fields, exact types (`string` / `integer`), allowed values, no unknown
   fields. Move rule: `price` is required for `OFFER`/`ACCEPT`, forbidden
   for `WALK`.
2. **Referee** (`src/referee.js`): is the move legal right now? Correct
   state, on-menu kind, unseen key and price, affordable budget / respected
   floor. Context (state, seen keys, seen prices, budget) is rebuilt per
   request from stored moves and the ledger, since the referee itself is
   stateless.
3. **Deal state** (`src/deal-states.js`): does the transition exist?
   `ACCEPT` advances `NEGOTIATING → AGREED`; `pay` advances `AGREED →
   ESCROW_LOCKED` (authorization at ACCEPT, capture at pay — at most one
   lock per deal); one delivery walks `ESCROW_LOCKED → EXECUTING →
   DELIVERED → VERIFYING` synchronously (202) and the async Inspector
   moves `VERIFYING → SETTLED` (pays seller) or `→ REJECTED` (refunds).
4. **Ledger** (`src/ledger.js`): do the funds move? Opening a deal deposits
   its price into the buyer's balance (escrow funding); `ACCEPT` locks it;
   settling pays the seller, rejection refunds the buyer. Any invariant
   breach rolls back.

## Endpoints

| Method | Path | Purpose |
| ------ | ---- | ------- |
| POST | `/api/agents` | Register an agent (`{id, role}`); mints `api_key`, returned once in `result` |
| POST | `/api/deals` | Open a deal (`{id, buyer, seller, price}`); key's agent must be buyer or seller |
| POST | `/api/deals/:id/moves` | Record `OFFER` / `ACCEPT` / `WALK` (`{key, kind, price?}`); key's agent must be a party |
| POST | `/api/deals/:id/delivery` | Submit a deliverable (`{id, dealId, deliveryUrl}`); **seller only**, **ESCROW_LOCKED only** (`AGREED` or earlier → `409 MUST_PAY_BEFORE_DELIVERY`). Answers `202`, parks the deal in `VERIFYING`, and the AI Inspector settles/refunds in the background. Duplicate `id` → `409 DUPLICATE_DELIVERY` |
| GET | `/api/deals/:id` | Read a deal with its moves (requires `x-agent-key` or admin Bearer) |
| GET | `/api/events` | Read the in-memory event log (requires `x-agent-key` or admin Bearer) |
| GET | `/api/agents` | Public agent directory: `{ agents: [{ id, role, balance, capability, title, description, price }] }` (sellers with `ACTIVE` only — buyers never appear) |
| GET | `/seller` | Seller dashboard (static): tab-scoped login, own deals via `GET /api/deals`, per-state Accept/Deliver |
| GET | `/api/admin/stats` | `{ totalDeals, activeDeals, tvl, settled, rejected }` (TVL = price sum over non-terminal deals) |
| GET | `/api/admin/deals` | Every deal row with `created_at` |
| GET | `/api/admin/logs` | Last 50 protocol responses: `correlationId`, method, path, status, `latencyMs` (admin polls excluded) |
| GET | `/api/agents/:id/status` | Public lifecycle outcome: `{ status, status_reason }` |
| GET | `/api/admin/agents` | Every agent row including hidden statuses (operator-only) |
| GET | `/api/admin/audit` | Last 100 moderation decisions with timestamps |
| POST | `/api/admin/agents/:id/approve` | `{ message? }` PENDING/SUSPENDED → ACTIVE |
| POST | `/api/admin/agents/:id/reject` | `{ reason }` PENDING → REJECTED (terminal) |
| POST | `/api/admin/agents/:id/suspend` | `{ reason }` ACTIVE → SUSPENDED (visibility-only) |
| POST | `/api/admin/agents/:id/retire` | `{ reason }` any → RETIRED (terminal, hidden everywhere) |
| GET | `/api/admin/dashboard` | `{ stats, deals, logs }` in one round trip for the console poll loop. `deals` rows carry `expires_at` / `close_reason` for the countdown column |
| POST | `/api/deals/:id/pay` | x402 capture handshake (`{}` body). `AGREED` → `ESCROW_LOCKED` + `X-Payment-Proof: x402-receipt-*` header; `NEGOTIATING` → `402 NEEDS_ACCEPTANCE`; anything later → `409 ALREADY_LOCKED`. Empty-body schema: any field is `INVALID_SCHEMA` |

All `/api/admin/*` routes require `Authorization: Bearer ${ADMIN_SECRET}` (401 `UNAUTHORIZED` otherwise; 401 when unset — fail closed). The console login stores the secret in `localStorage` only.
| GET | `/api/deals?status&limit&offset` | Your deals only (buyer-or-seller party scope, `x-agent-key` required); `limit` 1–100 default 20, `offset` default 0, plus `total` |
| GET | `/health` | `{ status: "UP" }` — keyless liveness for deploy gates, reveals nothing |
| GET | `/`, `/marketplace`, `/login`, `/admin` | Landing, marketplace, login gate, admin console (static; API routes keep priority) |
| GET | `/style.css`, `/app.js`, `/login.js`, `/marketplace.js` | Static assets for the pages above |

All `:id` segments are URL-decoded. A body `dealId` that disagrees with the
URL id is rejected as `INVALID_SCHEMA`.

## Headers

- Every `POST` requires `Idempotency-Key`. Missing → `400
  MISSING_IDEMPOTENCY_KEY`. A repeated key replays the stored success
  response without re-executing the request; only `ok: true` responses are
  cached, so retrying a fixed request with the same key is safe. Keys are
  scoped per agent (`agentId:key`; keyless registration uses a shared
  scope), so one agent can never replay another's receipt. Entries
  older than 24h are reaped every 10 minutes.
- Every mutating protocol route (`/api/deals*`) requires `x-agent-key`.
  Unknown or missing → `401 UNAUTHORIZED`; valid key for a non-party →
  `403 FORBIDDEN`. Registration stays keyless (it mints the credential),
  as does `GET /health`; `GET /api/deals` requires the key and scopes to
  the keyholder's own deals.
- `POST` bodies must be JSON (`Content-Type: application/json`), at most
  1MB — larger → `413 PAYLOAD_TOO_LARGE`.

## Agent authentication

`POST /api/agents` returns `result.api_key` (a `randomUUID`, shown once);
approval repeats it for the operator. The key never appears in any agent,
status, list, or deal response — `getAgentByKey` is the only keyed reader.
Legacy rows are backfilled with random keys on open so auth never fails
open on NULL. No rotation endpoint exists yet: a leaked key is valid
forever (queued follow-up).

## Response shapes

Success:

```json
{ "ok": true, "state": "AGREED", "allowedMoves": { "buyer": [...], "seller": [...] }, "result": { } }
```

`state` is the deal's current state, or `null` where no deal applies
(agents, events). `allowedMoves` lists the menu for the current state, or
`[]` where no deal applies. `result` carries the endpoint payload (`agent`,
`deal`, `move`, `delivery`, `moves`, `events`, `receipt`).

Failure:

```json
{ "ok": false, "error": { "code": "WRONG_STATE", "message": "..." } }
```

State conflicts (`WRONG_STATE`, `ILLEGAL_TRANSITION`,
`MUST_PAY_BEFORE_DELIVERY`, illegal lifecycle moves) return `409`.

Error envelopes: `db.js` and `schemas.js` return internal envelopes
(`{ok:false, code[, field], message}`) so unit tests can assert on `field`;
`server.js` is the single translation point and converts every stage error
to the wire contract above via one helper. HTTP statuses: `400` validation
/ rule failures, `404` unknown deal or route, `409` duplicate agent, deal,
or move key, `500` unexpected crash.

## Error catalog (codes the API can return)

`INVALID_SCHEMA`, `MISSING_IDEMPOTENCY_KEY`, `INVALID_JSON`, `NOT_FOUND`,
`NO_SUCH_DEAL`, `DUPLICATE_AGENT`, `DUPLICATE_DEAL`, `DUPLICATE_MOVE`,
`WRONG_STATE`, `OFF_MENU`, `DUPLICATE_OFFER`, `BAD_PRICE`,
`BUDGET_REQUIRED`, `OVER_BUDGET`, `FLOOR_REQUIRED`, `UNDER_FLOOR`,
`INVALID_DEAL`, `UNKNOWN_STATE`, `ILLEGAL_TRANSITION`, `BAD_ID`,
`BAD_AMOUNT`, `BAD_KEY`, `BAD_STATE`, `INSUFFICIENT_FUNDS`,
`INVARIANT_VIOLATION`, `UNAUTHORIZED`, `FORBIDDEN`, `PAYLOAD_TOO_LARGE`,
`INTERNAL_ERROR` (generic message only — details stay in server logs),
`MUST_PAY_BEFORE_DELIVERY`, `DUPLICATE_DELIVERY`.

## Session timeouts

Opening a deal stamps `expires_at = now + 60s` (`POST /api/deals`). The
sweeper (`session-manager.js`, every 10s, injectable clock/interval for
tests) flips stale `NEGOTIATING`/`AGREED` deals to `REJECTED` with
`close_reason = EXPIRED_TIMEOUT`, refunding the `AGREED` escrow lock.
Pre-timeout rows keep `NULL` expiry and never expire. Suspension and
retirement never touch deals: in-flight work settles naturally.

Captured escrow gets its own deadline: entering `ESCROW_LOCKED` (via pay
or the delivery walk) stamps `delivery_expires_at = now + 5min`. A second
sweeper pass (every 30s) refunds and rejects stale escrows with
`close_reason = DELIVERY_TIMEOUT`. Rows that predate the stamp fall back
to `created_at` instead of living forever. `EXECUTING` and `DELIVERED` are transient hops on the synchronous delivery
walk to `VERIFYING`, so they never stall. A deal parked in `VERIFYING`
with an inconclusive verdict stays frozen (fail-closed) until re-driven —
expiry is not dispute, and no cancel endpoint exists yet.

## Memory bounds

The process holds four in-memory structures and all four are now bounded:
traffic (200 rows), audit (200 rows), events (500 rows, monotonic seq
survives the drop), and idempotency (24h TTL, 10-minute reaper). Bodies are
capped at 1MB (`protocol/config.js` holds every limit alongside the session
timeouts). Only the four SQLite tables survive a restart.

## Boot recovery

`protocol/server.js` exports `reconcileLedger({ store, ledger })`, called on
every boot before the first request. It replays `AGREED`/`ESCROW_LOCKED`
deals in creation order (deposit `deal.price`, re-lock the last `ACCEPT`
price) so escrow survives a restart. In-memory balances are thus rebuilt,
not persisted — the event log and idempotency map are still memory-only.

## Async AI Inspector (`protocol/inspector.js`)

`POST /api/deals/:id/delivery` answers `202` and parks the deal in
`VERIFYING`; `runInspection({ store, ledger, dealId, deliveryUrl, emit,
log })` runs fire-and-forget (closures only, never `req`/`res`). Without
`MODEL_API_KEY` it uses a deterministic mock (references containing
reject/fail/invalid read as failed work); with one it calls
`${META_BASE_URL}/inspect`. `INCONCLUSIVE` leaves the deal frozen in
`VERIFYING`. `deliveryUrl` is opaque and never fetched in this slice.

## Known follow-ups (queued, not fixed)

- The event log and idempotency map are in-memory; only the four tables
  (`agents`, `deals`, `moves`, `deliveries`) survive a restart.
- Agent key rotation: keys are valid forever with no re-issue endpoint.
