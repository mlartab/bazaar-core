// Brick 5: HTTP endpoints. node:http with no framework.
//
// Every request runs the same pipeline in this order:
// schema -> referee -> deal state -> ledger. Stages that do not apply to an
// endpoint pass through. Every response uses the contract shape:
//   { ok: true, state, allowedMoves, result }
//   { ok: false, error: { code, message } }
// Every POST requires an Idempotency-Key header; a repeated key replays the
// stored success response without re-executing the request.
//
// Funding model: opening a deal deposits its price into the buyer's ledger
// balance, so the later ACCEPT lock can succeed. Registering an agent
// ensures the agent owns a (possibly zero) ledger balance entry, which
// settle requires of the seller.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import helmet from "helmet";
import { logger } from "./logger.js";
import { openStore } from "./db.js";
import { createSessionManager } from "./session-manager.js";
import { EVENT_CAP, IDEMPOTENCY_SWEEP_MS, IDEMPOTENCY_TTL_MS, MAX_BODY_SIZE } from "./config.js";

// Pure reaper for the idempotency map: entries older than ttlMs are dropped.
// Exported so tests can prove the 24h policy without waiting a day.
export function pruneIdempotency(map, now, ttlMs) {
  for (const [key, entry] of map) {
    if (entry.at < now - ttlMs) map.delete(key);
  }
}

// Boot recovery: the ledger is in-memory but deals are SQLite, so a restart
// vaporizes escrow. Replay every live lock in creation (rowid) order: each
// AGREED/ESCROW_LOCKED deal re-deposits its price into the buyer's balance
// (mirroring POST /api/deals) and re-locks it. NEGOTIATING deals hold no
// lock by design and are skipped. Per-deal try/catch so one corrupt row
// cannot abort the rest; every outcome is returned for the caller to log.
export function reconcileLedger({ store, ledger }) {
  const outcomes = [];
  for (const deal of store.listDeals()) {
    if (deal.state !== "AGREED" && deal.state !== "ESCROW_LOCKED") continue;
    try {
      // Zero entries keep the invariant (total unchanged) while satisfying
      // settle, which refuses to pay a seller with no balance account at
      // all. Mirrors ensureAccount on the live request path.
      for (const party of [deal.buyer, deal.seller]) {
        if (typeof party === "string" && !Object.hasOwn(ledger.balances, party)) {
          ledger.balances[party] = 0;
        }
      }
      // Replay the original funding exactly: opening deposited deal.price,
      // and ACCEPT locked the last ACCEPT price (falling back to deal.price
      // when the lock came from pay). Any remainder stays buyer balance,
      // just as before the restart.
      const accepts = store.listMoves(deal.id).filter((m) => m.kind === "ACCEPT" && Number.isInteger(m.price));
      const escrow = accepts.length > 0 ? accepts[accepts.length - 1].price : deal.price;
      const funded = deposit(ledger, deal.buyer, deal.price);
      if (!funded.ok) throw new Error(funded.message);
      const locked = lock(ledger, deal.buyer, deal.id, escrow);
      if (!locked.ok) throw new Error(locked.message);
      outcomes.push({ id: deal.id, from: deal.state, relocked: escrow });
    } catch (err) {
      outcomes.push({ id: deal.id, from: deal.state, relocked: null, error: err?.message ?? "reconcile failed" });
    }
  }
  return outcomes;
}
import { validate as validateSchema } from "./schemas.js";
import { runInspection } from "./inspector.js";
import { validate as validateReferee } from "../src/referee.js";
import { allowedMoves } from "../src/menu.js";
import { EDGES, transition } from "../src/deal-states.js";
import { createLedger, deposit, lock } from "../src/ledger.js";

const PRICED_KINDS = new Set(["OFFER", "ACCEPT"]);

function error(code, message) {
  return { ok: false, error: { code, message } };
}

// Single translation point from internal stage envelopes
// ({ ok: false, code, message[, field] } from schemas/db/src) to the wire
// contract above. Internal shapes keep their detail (e.g. schemas' `field`)
// so unit tests can assert on it; only the API boundary speaks `error`.
// Coerce any error code to strict UPPERCASE_SNAKE_CASE so downstream
// agents can match on it mechanically. Every code the pipeline emits is
// already in that form, so this is the identity function today and a
// safety net for future codes.
function normalizeErrorCode(code) {
  return String(code).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function toContractError(result) {
  return error(normalizeErrorCode(result.code), result.message);
}

// Conflict precision: state races are 409s, not 400s. Anything else keeps
// the status its call site already chose.
function stageError(result, fallback = 400) {
  if (result?.ok === false && (result.code === "WRONG_STATE" || result.code === "ILLEGAL_TRANSITION")) {
    return [409, toContractError(result)];
  }
  return [fallback, toContractError(result)];
}

// One helmet instance for the process: it only sets headers, so sharing it
// across requests is safe.
const helmetMiddleware = helmet();

function applyHelmet(req, res) {
  return new Promise((resolve, reject) => {
    helmetMiddleware(req, res, (err) => (err ? reject(err) : resolve()));
  });
}

function movesFor(state) {
  return { buyer: allowedMoves(state, "buyer"), seller: allowedMoves(state, "seller") };
}

// Bounded body reader: bytes are counted per chunk so a sender cannot OOM
// the process before we decide to reject it. Past the cap the promise
// rejects with a coded error the dispatcher maps to 413, and the rest of
// the body is drained (not stored) so the socket can still carry the
// response. Anything else unreadable stays a 400 at the call site.
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(Object.assign(new Error("request body too large"), { code: "PAYLOAD_TOO_LARGE" }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (!failed) reject(err);
    });
  });
}

export function createApp(dbPath) {
  const store = openStore(dbPath);
  if (store.ok === false) throw new Error(store.message);
  // Fail closed: without a secret the admin console can never be unlocked,
  // so every admin route answers 401 rather than serving open.
  if (typeof process.env.ADMIN_SECRET !== "string" || process.env.ADMIN_SECRET.length === 0) {
    logger.warn("ADMIN_SECRET is not set; all /api/admin/* routes will answer 401");
  }
  const ledger = createLedger();
  // Boot recovery runs before the first request: any AGREED/ESCROW_LOCKED
  // rows left by a previous process get their in-memory locks replayed, so
  // a restart never vaporizes escrow. Failures are logged, never thrown.
  try {
    const recovered = reconcileLedger({ store, ledger });
    if (recovered.length > 0) logger.info({ recovered }, "ledger.reconciled");
  } catch (err) {
    logger.error({ err }, "ledger.reconcile_crashed");
  }
  // Session timeouts live beside the pipeline, never inside it: the
  // request path stamps expires_at on open, and the sweeper below flips
  // stale NEGOTIATING/AGREED deals to REJECTED. Started here so every app
  // gets one; unref'd so a forgotten app never holds the process open.
  const sessions = createSessionManager({ store, ledger });
  const events = [];
  const idempotency = new Map();
  // Entries carry their write time; anything older than the TTL is reaped
  // on a slow unref'd interval so the map cannot grow for the life of the
  // process. Unref'd like the session sweeper: a forgotten app never holds
  // the event loop open on its own.
  const idemSweep = setInterval(() => {
    try {
      pruneIdempotency(idempotency, Date.now(), IDEMPOTENCY_TTL_MS);
    } catch {
      // Reaping must never kill the process; the next tick retries.
    }
  }, IDEMPOTENCY_SWEEP_MS);
  if (typeof idemSweep.unref === "function") idemSweep.unref();
  // Bounded in-memory traffic log for the admin console: every response
  // appends one entry, oldest first out. Never read by the pipeline itself,
  // so it cannot affect protocol behavior.
  const traffic = [];
  const TRAFFIC_CAP = 200;
  const recordTraffic = (entry) => {
    // The console polls admin endpoints on a timer; logging those responses
    // would drown real protocol traffic in observer noise.
    if (entry.path.startsWith("/api/admin")) return;
    // `at` lets the console Clear to "everything so far" instead of nuking
    // the pane every 2-second poll.
    traffic.push({ at: Date.now(), ...entry });
    if (traffic.length > TRAFFIC_CAP) traffic.splice(0, traffic.length - TRAFFIC_CAP);
  };
  let seq = 0;

  const emit = (event) => {
    seq += 1;
    events.push({ seq, at: Date.now(), ...event });
    // Bounded like traffic: the feed keeps the newest EVENT_CAP rows while
    // the monotonic seq survives the drop, so consumers can see the gap.
    if (events.length > EVENT_CAP) events.splice(0, events.length - EVENT_CAP);
  };

  // Expiry is a protocol event, not just a row update: the console's deal
  // table and traffic feed stay truthful when a negotiation dies quietly.
  sessions.start((outcomes) => {
    for (const outcome of outcomes) {
      if (outcome.to === "REJECTED") {
        emit({ type: "STATE", dealId: outcome.id, from: outcome.from, to: "REJECTED", reason: outcome.reason ?? "EXPIRED_TIMEOUT" });
      }
    }
    if (outcomes.length > 0) logger.info({ outcomes }, "session.sweep");
  });

  // Operator-only audit trail: every moderation decision lands here with a
  // timestamp, separate from the protocol events feed so neither consumer
  // sees the other's rows. Never read by the pipeline itself.
  const audit = [];
  const AUDIT_CAP = 200;
  const recordAudit = (entry) => {
    audit.push({ at: Date.now(), ...entry });
    if (audit.length > AUDIT_CAP) audit.splice(0, audit.length - AUDIT_CAP);
  };

  // A zero entry keeps the invariant (total unchanged) while satisfying
  // settle, which refuses to pay a seller with no balance account at all.
  const ensureAccount = (agentId) => {
    if (!Object.hasOwn(ledger.balances, agentId)) ledger.balances[agentId] = 0;
  };

  const refereeContext = (deal) => {
    const rows = store.listMoves(deal.id);
    return {
      state: deal.state,
      // Moves are submitted on the buyer's behalf: only the buyer locks
      // funds, so budget (not floor) is the binding price rule.
      role: "buyer",
      budget: ledger.balances[deal.buyer] ?? deal.price,
      seenKeys: rows.map((row) => row.key),
      seenOffers: rows.filter((row) => PRICED_KINDS.has(row.kind)).map((row) => row.price),
    };
  };

  // Fast path for the delivery route: every synchronous check that can
  // reject the request before any state changes (URL/body agreement, schema
  // shape, deal existence). The future async AI Inspector plugs in right
  // after this returns ok, so slow verification never blocks cheap rejection.
  // Returns { ok: true, deal, delivery } or { ok: false, status, payload }
  // where payload already speaks the wire contract.
  const fastValidateDelivery = (dealId, payload) => {
    const deal = store.getDeal(dealId);
    if (deal === null) {
      return { ok: false, status: 404, payload: error("NO_SUCH_DEAL", `no deal with id ${dealId}`) };
    }
    if (payload !== null && typeof payload === "object" && payload.dealId !== undefined && payload.dealId !== dealId) {
      return { ok: false, status: 400, payload: error("INVALID_SCHEMA", "field dealId must match the URL deal id") };
    }
    const merged = { dealId, ...payload };
    const checked = validateSchema("delivery", merged);
    if (!checked.ok) return { ok: false, status: 400, payload: toContractError(checked) };
    return { ok: true, deal, delivery: merged };
  };

  const handlers = {
    // Public by design: a marketplace is useless if buyers cannot see who
    // is selling, what they sell, and how much stake they hold.
    "GET /api/agents": () => {
      return [200, { ok: true, state: null, allowedMoves: [], result: { agents: store.listAgents() } }];
    },

    // Public: how a registered agent polls its own lifecycle outcome.
    "GET /api/agents/:id/status": (_body, id) => {
      const review = store.getAgentStatus(id);
      if (review === null) return [404, error("NO_SUCH_AGENT", `no agent with id ${id}`)];
      return [200, { ok: true, state: null, allowedMoves: [], result: review }];
    },

    "POST /api/agents": (body) => {
      const checked = validateSchema("registerAgent", body);
      if (!checked.ok) return [400, toContractError(checked)];
      if (store.getAgent(body.id) !== null) {
        return [409, error("DUPLICATE_AGENT", `agent ${body.id} is already registered`)];
      }
      // getAgent's column list is frozen for existing readers, so the
      // agent shape stays { id, role, balance }; the credential rides
      // beside it, shown once like a Stripe secret key.
      const apiKey = randomUUID();
      store.saveAgent({ id: body.id, role: body.role, balance: 0, capability: body.capability, title: body.title, description: body.description, price: body.price, api_key: apiKey });
      ensureAccount(body.id);
      emit({ type: "AGENT_REGISTERED", agentId: body.id, role: body.role });
      // The queue message rides beside the frozen agent shape, so existing
      // readers keep passing while new agents learn they are not listed yet.
      return [
        200,
        {
          ok: true,
          state: null,
          allowedMoves: [],
          result: {
            agent: store.getAgent(body.id),
            message: "Agent registered successfully. Your listing is currently in the review queue.",
            api_key: apiKey,
          },
        },
      ];
    },

    "POST /api/deals": (body, _id, agent) => {
      const checked = validateSchema("openDeal", body);
      if (!checked.ok) return [400, toContractError(checked)];
      // Either counterparty may open; anyone else is a bystander.
      if (agent.id !== body.buyer && agent.id !== body.seller) {
        return [403, error("FORBIDDEN", `agent ${agent.id} is not a party of this deal`)];
      }
      if (store.getDeal(body.id) !== null) {
        return [409, error("DUPLICATE_DEAL", `deal ${body.id} already exists`)];
      }
      ensureAccount(body.buyer);
      ensureAccount(body.seller);
      const funded = deposit(ledger, body.buyer, body.price);
      if (!funded.ok) return [400, toContractError(funded)];
      // The 60s negotiation window starts the moment the deal opens; the
      // sweeper reads this stamp, and NULL (pre-timeout rows) never expires.
      store.saveDeal({ id: body.id, state: "NEGOTIATING", buyer: body.buyer, seller: body.seller, price: body.price, expires_at: sessions.expiresAt() });
      emit({ type: "DEAL_OPENED", dealId: body.id, state: "NEGOTIATING" });
      const deal = store.getDeal(body.id);
      return [200, { ok: true, state: deal.state, allowedMoves: movesFor(deal.state), result: { deal } }];
    },

    "POST /api/deals/:id/moves": (body, id, agent) => {
      const deal = store.getDeal(id);
      if (deal === null) return [404, error("NO_SUCH_DEAL", `no deal with id ${id}`)];
      if (agent.id !== deal.buyer && agent.id !== deal.seller) {
        return [403, error("FORBIDDEN", `agent ${agent.id} is not a party of deal ${id}`)];
      }
      const merged = { dealId: id, ...body };
      if (body !== null && typeof body === "object" && body.dealId !== undefined && body.dealId !== id) {
        return [400, error("INVALID_SCHEMA", "field dealId must match the URL deal id")];
      }
      const checked = validateSchema("move", merged);
      if (!checked.ok) return [400, toContractError(checked)];
      const move = { key: merged.key, kind: merged.kind, price: merged.price };
      const ruled = validateReferee(move, refereeContext(deal));
      if (!ruled.ok) return stageError(ruled);
      let next = null;
      if (merged.kind === "ACCEPT") {
        const advanced = transition(deal, "AGREED");
        if (!advanced.ok) return stageError(advanced);
        next = advanced;
      }
      const saved = store.saveMove({
        id: `${id}:${merged.key}`,
        deal_id: id,
        key: merged.key,
        kind: merged.kind,
        price: merged.price ?? null,
      });
      if (!saved.ok) return [409, toContractError(saved)];
      emit({ type: "MOVE_RECORDED", dealId: id, key: merged.key, kind: merged.kind });
      if (next !== null) {
        store.setDealState(id, next.deal.state);
        emit({ type: "STATE", dealId: id, from: next.event.from, to: next.event.to });
        const locked = lock(ledger, deal.buyer, id, merged.price);
        if (!locked.ok) return [400, toContractError(locked)];
        emit({ type: "ESCROW_LOCKED", dealId: id, amount: merged.price });
      }
      const current = store.getDeal(id);
      return [
        200,
        {
          ok: true,
          state: current.state,
          allowedMoves: movesFor(current.state),
          result: { move: { dealId: id, key: merged.key, kind: merged.kind, price: merged.price ?? null } },
        },
      ];
    },

    // x402 payment simulation: AGREED is the deal's single payable window.
    // ACCEPT pre-authorized the funds (authorization), and this handshake
    // captures them (capture): if the lock is somehow missing we lock here,
    // but if ACCEPT already locked we never lock twice — the state flip to
    // ESCROW_LOCKED is the effect, the receipt header is the proof.
    "POST /api/deals/:id/pay": (body, id, agent) => {
      const checked = validateSchema("pay", body);
      if (!checked.ok) return [400, toContractError(checked)];
      const deal = store.getDeal(id);
      if (deal === null) return [404, error("NO_SUCH_DEAL", `no deal with id ${id}`)];
      if (agent.id !== deal.buyer && agent.id !== deal.seller) {
        return [403, error("FORBIDDEN", `agent ${agent.id} is not a party of deal ${id}`)];
      }
      if (deal.state === "NEGOTIATING") {
        return [402, error("NEEDS_ACCEPTANCE", `deal ${id} has no accepted price to pay yet`)];
      }
      if (deal.state !== "AGREED") {
        return [409, error("ALREADY_LOCKED", `deal ${id} is ${deal.state}; its single escrow lock already happened`)];
      }
      if (ledger.locks[id] === undefined) {
        const locked = lock(ledger, deal.buyer, id, deal.price);
        if (!locked.ok) return [400, toContractError(locked)];
      }
      const advanced = transition(deal, "ESCROW_LOCKED");
      if (!advanced.ok) return [409, toContractError(advanced)];
      store.setDealState(id, advanced.deal.state);
      // Truthful amount: the lock is authoritative, whether ACCEPT funded it
      // at a discounted price or pay just locked the full deal price. Both
      // paths above guarantee a lock exists here (failures return early).
      emit({ type: "ESCROW_LOCKED", dealId: id, amount: ledger.locks[id].amount });
      // Capture starts the delivery clock: a seller who never delivers
      // after this stamp loses the lock to the delivery sweeper.
      store.setDealDeliveryExpiry(id, sessions.deliveryExpiresAt());
      // A real-looking receipt: the client proves capture with this string,
      // the server proves it with the matching ledger lock.
      const receipt = `x402-receipt-${randomUUID()}`;
      const current = store.getDeal(id);
      return [
        200,
        { ok: true, state: current.state, allowedMoves: movesFor(current.state), result: { deal: current, receipt } },
        { "x-payment-proof": receipt },
      ];
    },

    // Agent-loop friendly async delivery: the synchronous path validates,
    // records, and parks the deal in VERIFYING, then answers 202. The AI
    // Inspector (protocol/inspector.js) decides SETTLED vs REJECTED in the
    // background. The client never supplies a verdict: there is no status
    // field, so the client-decides-settlement hole is closed by schema.
    "POST /api/deals/:id/delivery": (body, id, agent) => {
      const fast = fastValidateDelivery(id, body);
      if (!fast.ok) return [fast.status, fast.payload];
      const { deal, delivery: merged } = fast;
      // Seller-only: the buyer cannot deliver their own work.
      if (agent.id !== deal.seller) {
        return [403, error("FORBIDDEN", `only the seller of deal ${id} can deliver`)];
      }
      // Escrow-only: delivery requires captured funds. AGREED (or anything
      // earlier) means pay has not happened yet; the old walk-in capture is
      // gone by design, so escrow always has a real ledger lock behind it.
      if (deal.state !== "ESCROW_LOCKED") {
        return [409, error("MUST_PAY_BEFORE_DELIVERY", `deal ${id} is ${deal.state}; delivery requires a paid escrow`)];
      }
      try {
        const saved = store.saveDelivery({ id: merged.id, deal_id: id, status: null, delivery_url: merged.deliveryUrl });
        if (!saved.ok) {
          if (saved.code === "DUPLICATE_DELIVERY") return [409, toContractError(saved)];
          if (saved.code === "BAD_ID") return [400, toContractError(saved)];
          return [400, toContractError(saved)];
        }
        // One chained walk to VERIFYING with an event per hop, so the feed
        // stays truthful about every state the deal passed through.
        let current = deal;
        for (const hop of ["EXECUTING", "DELIVERED", "VERIFYING"]) {
          const advanced = transition(current, hop);
          if (!advanced.ok) return stageError(advanced);
          store.setDealState(id, advanced.deal.state);
          emit({ type: "STATE", dealId: id, from: advanced.event.from, to: advanced.event.to });
          current = advanced.deal;
        }
        emit({ type: "DELIVERY_RECORDED", dealId: id, deliveryId: merged.id });
      } catch (err) {
        // The record or a hop failed mid-walk: log the real error, report
        // generic, and leave the row for the operator. Partial walks are
        // visible as STATE events, never silent.
        logger.error({ err, dealId: id }, "delivery.walk_failed");
        return [500, error("INTERNAL_ERROR", "An unexpected error occurred.")];
      }
      // Fire-and-forget verdict: closures only, never req/res. A rejection
      // logs and leaves the deal VERIFYING (frozen), never settles on doubt.
      runInspection({ store, ledger, dealId: id, deliveryUrl: merged.deliveryUrl, emit, log: logger }).catch((err) => {
        logger.error({ err, dealId: id }, "inspector.crashed");
      });
      const current = store.getDeal(id);
      return [
        202,
        {
          ok: true,
          state: current.state,
          allowedMoves: movesFor(current.state),
          result: { delivery: { id: merged.id, dealId: id, deliveryUrl: merged.deliveryUrl }, message: "Delivery accepted for inspection." },
        },
      ];
    },

    // Agent-scoped deal listing: you see only deals where you are buyer or
    // seller, so agents poll for their own work without scraping the whole
    // table. Status is validated against the machine; limit/offset bound
    // the page.
    "GET /api/deals": (body, id, agent, query) => {
      const { status, limit: limitRaw, offset: offsetRaw } = query ?? {};
      if (status !== undefined && (typeof status !== "string" || !Object.hasOwn(EDGES, status))) {
        return [400, error("INVALID_SCHEMA", `unknown status filter: ${String(status)}`)];
      }
      const limit = limitRaw === undefined ? 20 : Number(limitRaw);
      const offset = offsetRaw === undefined ? 0 : Number(offsetRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
        return [400, error("INVALID_SCHEMA", "limit must be an integer 1-100 and offset a non-negative integer")];
      }
      return [
        200,
        {
          ok: true,
          state: null,
          allowedMoves: [],
          result: {
            deals: store.listDealsByParty(agent.id, { status, limit, offset }),
            total: store.countDealsByParty(agent.id, status),
          },
        },
      ];
    },

    "GET /api/deals/:id": (_body, id) => {
      const deal = store.getDeal(id);
      if (deal === null) return [404, error("NO_SUCH_DEAL", `no deal with id ${id}`)];
      return [
        200,
        {
          ok: true,
          state: deal.state,
          allowedMoves: movesFor(deal.state),
          result: { deal, moves: store.listMoves(id) },
        },
      ];
    },

    "GET /api/events": () => {
      return [200, { ok: true, state: null, allowedMoves: [], result: { events } }];
    },

    // Unauthenticated by design: load balancers and deploy gates need a
    // keyless liveness signal, and it reveals nothing.
    "GET /health": () => {
      return [200, { ok: true, state: null, allowedMoves: [], result: { status: "UP" } }];
    },

    "GET /api/admin/stats": () => {
      return [200, { ok: true, state: null, allowedMoves: [], result: store.dealStats() }];
    },

    "GET /api/admin/deals": () => {
      return [200, { ok: true, state: null, allowedMoves: [], result: { deals: store.listDeals() } }];
    },

    "GET /api/admin/logs": () => {
      return [200, { ok: true, state: null, allowedMoves: [], result: { logs: traffic.slice(-50) } }];
    },

    // One poll per dashboard tick: same fields as the three endpoints above,
    // composed here so the console never pays three round trips.
    "GET /api/admin/dashboard": () => {
      return [
        200,
        {
          ok: true,
          state: null,
          allowedMoves: [],
          result: { stats: store.dealStats(), deals: store.listDeals(), logs: traffic.slice(-50) },
        },
      ];
    },

    "GET /api/admin/agents": () => {
      return [200, { ok: true, state: null, allowedMoves: [], result: { agents: store.listAllAgents() } }];
    },

    "GET /api/admin/audit": () => {
      return [200, { ok: true, state: null, allowedMoves: [], result: { audit: audit.slice(-100) } }];
    },

    // One moderation decision: validate the note, run the lifecycle table,
    // record the audit row. Suspension is visibility-only by design: deals,
    // escrows, and balances are untouched, so in-flight work settles
    // naturally. (Blocking new deals from suspended agents is a follow-up,
    // deliberately not built here.)
    "POST /api/admin/agents/:id/approve": (body, id) => {
      const checked = validateSchema("reviewNote", body);
      if (!checked.ok) return [400, toContractError(checked)];
      const [status, payload] = decideAgent(id, "ACTIVE", body.message);
      if (status !== 200) return [status, payload];
      // The credential handoff: the operator sees the agent's key in the
      // approval response. Public routes can never return this field.
      return [200, { ...payload, result: { ...payload.result, api_key: store.getAgentApiKey(id) } }];
    },

    "POST /api/admin/agents/:id/reject": (body, id) => {
      const checked = validateSchema("moderationNote", body);
      if (!checked.ok) return [400, toContractError(checked)];
      return decideAgent(id, "REJECTED", body.reason);
    },

    "POST /api/admin/agents/:id/suspend": (body, id) => {
      const checked = validateSchema("moderationNote", body);
      if (!checked.ok) return [400, toContractError(checked)];
      return decideAgent(id, "SUSPENDED", body.reason);
    },

    "POST /api/admin/agents/:id/retire": (body, id) => {
      const checked = validateSchema("moderationNote", body);
      if (!checked.ok) return [400, toContractError(checked)];
      return decideAgent(id, "RETIRED", body.reason);
    },
  };

  function decideAgent(id, to, note) {
    const saved = store.setAgentStatus(id, to, note);
    if (!saved.ok) {
      const status = saved.code === "NO_SUCH_AGENT" ? 404 : 409;
      return [status, toContractError(saved)];
    }
    recordAudit({ action: to, agentId: id, from: saved.from, to: saved.to, reason: note ?? null });
    return [200, { ok: true, state: null, allowedMoves: [], result: store.getAgentStatus(id) }];
  }

  // Flat public/ directory only: no nested paths, no parent traversal, and
  // only the three types the site needs. Anything else falls through to
  // the JSON 404, so pages can never shadow an API route.
  const STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
  };
  // Extensionless page routes; checked before the flat-file fallback.
  const PAGES = {
    "/": "landing.html",
    "/marketplace": "marketplace.html",
    "/login": "login.html",
    "/admin": "admin.html",
    "/seller": "seller.html",
  };
  const PUBLIC_DIR = new URL("../public/", import.meta.url);
  const serveStatic = (pathname) => {
    const file = Object.hasOwn(PAGES, pathname) ? PAGES[pathname] : pathname.slice(1);
    if (file.includes("..") || file.includes("/") || file.includes("\\")) return null;
    const type = STATIC_TYPES[path.extname(file)];
    if (type === undefined) return null;
    try {
      return { type, text: fs.readFileSync(new URL(file, PUBLIC_DIR), "utf8") };
    } catch {
      return null;
    }
  };

  const match = (method, pathname) => {
    const direct = handlers[`${method} ${pathname}`];
    if (direct !== undefined) return [direct, undefined];
    if (method === "POST" || method === "GET") {
      const moves = pathname.match(/^\/api\/deals\/([^/]+)\/moves$/);
      if (moves !== null && method === "POST") {
        return [handlers["POST /api/deals/:id/moves"], decodeURIComponent(moves[1])];
      }
      const delivery = pathname.match(/^\/api\/deals\/([^/]+)\/delivery$/);
      if (delivery !== null && method === "POST") {
        return [handlers["POST /api/deals/:id/delivery"], decodeURIComponent(delivery[1])];
      }
      const pay = pathname.match(/^\/api\/deals\/([^/]+)\/pay$/);
      if (pay !== null && method === "POST") {
        return [handlers["POST /api/deals/:id/pay"], decodeURIComponent(pay[1])];
      }
      const deal = pathname.match(/^\/api\/deals\/([^/]+)$/);
      if (deal !== null && method === "GET" && decodeURIComponent(deal[1]) !== "") {
        return [handlers["GET /api/deals/:id"], decodeURIComponent(deal[1])];
      }
      const agentStatus = pathname.match(/^\/api\/agents\/([^/]+)\/status$/);
      if (agentStatus !== null && method === "GET" && decodeURIComponent(agentStatus[1]) !== "") {
        return [handlers["GET /api/agents/:id/status"], decodeURIComponent(agentStatus[1])];
      }
      const moderation = pathname.match(/^\/api\/admin\/agents\/([^/]+)\/(approve|reject|suspend|retire)$/);
      if (moderation !== null && method === "POST" && decodeURIComponent(moderation[1]) !== "") {
        return [handlers[`POST /api/admin/agents/:id/${moderation[2]}`], decodeURIComponent(moderation[1])];
      }
    }
    return [undefined, undefined];
  };

  // Bearer gate for the whole /api/admin/* subtree. Compared in constant
  // time so a wrong secret costs the same as a right one; checked before
  // routing so unknown admin paths 401 instead of leaking route existence.
  const checkAdmin = (req) => {
    const secret = process.env.ADMIN_SECRET;
    if (typeof secret !== "string" || secret.length === 0) {
      return error("UNAUTHORIZED", "admin console is not configured");
    }
    const header = req.headers.authorization ?? "";
    const a = Buffer.from(header);
    const b = Buffer.from(`Bearer ${secret}`);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return error("UNAUTHORIZED", "valid admin credentials required");
    }
    return null;
  };

  const server = http.createServer(async (req, res) => {
    // Correlation first: everything this request logs, including failures
    // in the Schema/Referee/Ledger stages below, carries this ID.
    const correlationId = randomUUID();
    req.correlationId = correlationId;
    req.log = logger.child({ correlationId });
    req.log.info({ method: req.method, url: req.url }, "request.in");
    const startedAt = Date.now();
    let loggedPath = req.url ?? "/";
    // Handlers may return [status, payload, headers]: the third element is
    // how endpoints like pay attach proof headers (X-Payment-Proof) without
    // the dispatcher knowing anything about payments.
    const send = (status, payload, headers) => {
      recordTraffic({
        correlationId,
        method: req.method ?? "GET",
        path: loggedPath,
        status,
        latencyMs: Date.now() - startedAt,
      });
      const text = JSON.stringify(payload);
      res.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(text),
        ...headers,
      });
      res.end(text);
    };
    const reject = (status, payload) => {
      req.log.warn({ status, code: payload.error?.code }, "request.rejected");
      send(status, payload);
    };
    try {
      // Helmet before routing: no response leaves without security headers,
      // and a helmet failure fails closed instead of serving insecurely.
      await applyHelmet(req, res);
      const parsed = new URL(req.url ?? "/", "http://localhost");
      const pathname = parsed.pathname;
      // Query rides to handlers as a plain object; only the deals listing
      // reads it today, the rest ignore the fourth argument.
      const query = Object.fromEntries(parsed.searchParams);
      const method = (req.method ?? "GET").toUpperCase();
      loggedPath = pathname;
      if (pathname.startsWith("/api/admin/")) {
        const denied = checkAdmin(req);
        if (denied !== null) {
          reject(401, denied);
          return;
        }
      }
      // Agent-scoped listing authenticates like the mutating routes: the key
      // decides whose deals you may see. Every other GET stays public.
      if (method === "GET" && pathname === "/api/deals") {
        const viewer = store.getAgentByKey(req.headers["x-agent-key"]);
        if (viewer === null) {
          reject(401, error("UNAUTHORIZED", "listing your deals requires a valid x-agent-key header"));
          return;
        }
        const [listStatus, listPayload] = handlers["GET /api/deals"](undefined, undefined, viewer, query);
        send(listStatus, listPayload);
        return;
      }
      // Deal detail and the events feed are agent-authenticated: a valid
      // x-agent-key is required. The operator console holds no agent key,
      // so a valid admin Bearer [REDACTED] accepted here too — either
      // credential proves you may read, and neither leaks into the other.
      if (method === "GET" && (pathname === "/api/events" || /^\/api\/deals\/[^/]+$/.test(pathname))) {
        const admin = checkAdmin(req);
        const viewer = admin === null ? { id: "admin" } : store.getAgentByKey(req.headers["x-agent-key"]);
        if (viewer === null) {
          reject(401, error("UNAUTHORIZED", "reading deals and events requires a valid x-agent-key header"));
          return;
        }
      }
      const [handler, id] = match(method, pathname);
      if (handler === undefined) {
        // Static console assets are served here so API routes keep
        // priority: anything serveStatic rejects still gets the JSON 404.
        if (method === "GET") {
          const asset = serveStatic(pathname);
          if (asset !== null) {
            recordTraffic({ correlationId, method, path: pathname, status: 200, latencyMs: Date.now() - startedAt });
            res.writeHead(200, { "content-type": asset.type, "content-length": Buffer.byteLength(asset.text) });
            res.end(asset.text);
            return;
          }
        }
        reject(404, error("NOT_FOUND", `no route for ${method} ${pathname}`));
        return;
      }
      if (method === "POST") {
        const key = req.headers["idempotency-key"];
        if (typeof key !== "string" || key.length === 0) {
          reject(400, error("MISSING_IDEMPOTENCY_KEY", "POST requests require an Idempotency-Key header"));
          return;
        }
        // Agent authentication, before idempotency: only the registration
        // route mints credentials, so it is the one mutating route that
        // stays keyless. A replay never skips this gate.
        let agent = null;
        if (pathname.startsWith("/api/deals")) {
          agent = store.getAgentByKey(req.headers["x-agent-key"]);
          if (agent === null) {
            reject(401, error("UNAUTHORIZED", "mutating protocol routes require a valid x-agent-key header"));
            return;
          }
        }
        // Idempotency is scoped per agent: the same key string from two
        // agents names two independent slots, so Agent B can never replay
        // Agent A's receipt. Keyless registration keeps the shared scope.
        const idemKey = agent !== null ? `${agent.id}:${key}` : `public:${key}`;
        const replay = idempotency.get(idemKey);
        if (replay !== undefined) {
          send(replay.status, replay.payload, replay.headers);
          return;
        }
        let body;
        try {
          const text = await readBody(req, MAX_BODY_SIZE);
          body = text.length === 0 ? {} : JSON.parse(text);
        } catch (err) {
          if (err?.code === "PAYLOAD_TOO_LARGE") {
            reject(413, error("PAYLOAD_TOO_LARGE", "request body exceeds 1MB"));
            return;
          }
          reject(400, error("INVALID_JSON", "request body must be valid JSON"));
          return;
        }
        const [status, payload, headers] = handler(body, id, agent);
        // Cache successes only: caching a rejection would freeze the first
        // error in place and punish clients that retry with a fixed request.
        // Headers ride along so a replayed pay still carries its receipt.
        // `at` feeds the TTL reaper so entries die after 24 hours.
        if (payload.ok === true) idempotency.set(idemKey, { status, payload, headers, at: Date.now() });
        if (payload.ok === false) req.log.warn({ status, code: payload.error?.code }, "request.rejected");
        send(status, payload, headers);
        return;
      }
      const [status, payload] = handler(undefined, id, undefined, query);
      if (payload.ok === false) req.log.warn({ status, code: payload.error?.code }, "request.rejected");
      send(status, payload);
    } catch (err) {
      // The real error goes to the logs only; the wire gets a generic
      // envelope so SQLite internals never leak to callers.
      req.log.error({ err }, "request.crashed");
      send(500, error("INTERNAL_ERROR", "An unexpected error occurred."));
    }
  });

  return { server, store, ledger, sessions, stopIdemSweep: () => clearInterval(idemSweep) };
}

export function startServer({ dbPath, port = 0 } = {}) {
  const { server, store, sessions, stopIdemSweep } = createApp(dbPath);
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actual = typeof address === "object" && address !== null ? address.port : port;
      resolve({
        url: `http://127.0.0.1:${actual}`,
        port: actual,
        close: () =>
          new Promise((done) => {
            server.close(() => {
              sessions.stop();
              stopIdemSweep();
              store.close();
              done();
            });
          }),
      });
    });
  });
}
