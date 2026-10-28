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
  process.

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
   `ACCEPT` advances `NEGOTIATING → AGREED`; each delivery advances one step
   toward `SETTLED` (or `REJECTED` from `VERIFYING`).
4. **Ledger** (`src/ledger.js`): do the funds move? Opening a deal deposits
   its price into the buyer's balance (escrow funding); `ACCEPT` locks it;
   settling pays the seller, rejection refunds the buyer. Any invariant
   breach rolls back.

## Endpoints

| Method | Path | Purpose |
| ------ | ---- | ------- |
| POST | `/api/agents` | Register an agent (`{id, role}`) |
| POST | `/api/deals` | Open a deal (`{id, buyer, seller, price}`) |
| POST | `/api/deals/:id/moves` | Record `OFFER` / `ACCEPT` / `WALK` (`{key, kind, price?}`) |
| POST | `/api/deals/:id/delivery` | Record delivery and advance the deal one step |
| GET | `/api/deals/:id` | Read a deal with its moves |
| GET | `/api/events` | Read the in-memory event log |

All `:id` segments are URL-decoded. A body `dealId` that disagrees with the
URL id is rejected as `INVALID_SCHEMA`.

## Headers

- Every `POST` requires `Idempotency-Key`. Missing → `400
  MISSING_IDEMPOTENCY_KEY`. A repeated key replays the stored success
  response without re-executing the request; only `ok: true` responses are
  cached, so retrying a fixed request with the same key is safe.
- `POST` bodies must be JSON (`Content-Type: application/json`).

## Response shapes

Success:

```json
{ "ok": true, "state": "AGREED", "allowedMoves": { "buyer": [...], "seller": [...] }, "result": { } }
```

`state` is the deal's current state, or `null` where no deal applies
(agents, events). `allowedMoves` lists the menu for the current state, or
`[]` where no deal applies. `result` carries the endpoint payload (`agent`,
`deal`, `move`, `delivery`, `moves`, `events`).

Failure:

```json
{ "ok": false, "error": { "code": "WRONG_STATE", "message": "..." } }
```

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
`INVARIANT_VIOLATION`.

## Known follow-ups (queued, not fixed)

- A duplicate delivery `id` currently escapes as `500 INTERNAL`
  (`saveDelivery` has no UNIQUE mapping, unlike `saveMove`). Queued for the
  Async AI Inspector brick: map it to a `409` contract error there.
- The event log and idempotency map are in-memory; only the four tables
  (`agents`, `deals`, `moves`, `deliveries`) survive a restart.
