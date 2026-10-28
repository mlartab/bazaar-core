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
import { randomUUID } from "node:crypto";
import helmet from "helmet";
import { logger } from "./logger.js";
import { openStore } from "./db.js";
import { validate as validateSchema } from "./schemas.js";
import { validate as validateReferee } from "../src/referee.js";
import { allowedMoves } from "../src/menu.js";
import { EDGES, transition } from "../src/deal-states.js";
import { createLedger, deposit, lock, settle, refund } from "../src/ledger.js";

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createApp(dbPath) {
  const store = openStore(dbPath);
  if (store.ok === false) throw new Error(store.message);
  const ledger = createLedger();
  const events = [];
  const idempotency = new Map();
  let seq = 0;

  const emit = (event) => {
    seq += 1;
    events.push({ seq, ...event });
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
    "POST /api/agents": (body) => {
      const checked = validateSchema("registerAgent", body);
      if (!checked.ok) return [400, toContractError(checked)];
      if (store.getAgent(body.id) !== null) {
        return [409, error("DUPLICATE_AGENT", `agent ${body.id} is already registered`)];
      }
      store.saveAgent({ id: body.id, role: body.role, balance: 0 });
      ensureAccount(body.id);
      emit({ type: "AGENT_REGISTERED", agentId: body.id, role: body.role });
      return [200, { ok: true, state: null, allowedMoves: [], result: { agent: store.getAgent(body.id) } }];
    },

    "POST /api/deals": (body) => {
      const checked = validateSchema("openDeal", body);
      if (!checked.ok) return [400, toContractError(checked)];
      if (store.getDeal(body.id) !== null) {
        return [409, error("DUPLICATE_DEAL", `deal ${body.id} already exists`)];
      }
      ensureAccount(body.buyer);
      ensureAccount(body.seller);
      const funded = deposit(ledger, body.buyer, body.price);
      if (!funded.ok) return [400, toContractError(funded)];
      store.saveDeal({ id: body.id, state: "NEGOTIATING", buyer: body.buyer, seller: body.seller, price: body.price });
      emit({ type: "DEAL_OPENED", dealId: body.id, state: "NEGOTIATING" });
      const deal = store.getDeal(body.id);
      return [200, { ok: true, state: deal.state, allowedMoves: movesFor(deal.state), result: { deal } }];
    },

    "POST /api/deals/:id/moves": (body, id) => {
      const deal = store.getDeal(id);
      if (deal === null) return [404, error("NO_SUCH_DEAL", `no deal with id ${id}`)];
      const merged = { dealId: id, ...body };
      if (body !== null && typeof body === "object" && body.dealId !== undefined && body.dealId !== id) {
        return [400, error("INVALID_SCHEMA", "field dealId must match the URL deal id")];
      }
      const checked = validateSchema("move", merged);
      if (!checked.ok) return [400, toContractError(checked)];
      const move = { key: merged.key, kind: merged.kind, price: merged.price };
      const ruled = validateReferee(move, refereeContext(deal));
      if (!ruled.ok) return [400, toContractError(ruled)];
      let next = null;
      if (merged.kind === "ACCEPT") {
        const advanced = transition(deal, "AGREED");
        if (!advanced.ok) return [400, toContractError(advanced)];
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

    "POST /api/deals/:id/delivery": (body, id) => {
      // Synchronous fast path first; the async AI Inspector will run after
      // this returns ok and before the state transition below.
      const fast = fastValidateDelivery(id, body);
      if (!fast.ok) return [fast.status, fast.payload];
      const { deal, delivery: merged } = fast;
      const edges = EDGES[deal.state];
      if (!Array.isArray(edges) || edges.length === 0) {
        return [400, error("ILLEGAL_TRANSITION", `cannot transition from ${deal.state}`)];
      }
      const to = edges.length === 1 ? edges[0] : merged.status === "DELIVERED" ? "SETTLED" : "REJECTED";
      const advanced = transition(deal, to);
      if (!advanced.ok) return [400, toContractError(advanced)];
      const saved = store.saveDelivery({ id: merged.id, deal_id: id, status: merged.status });
      if (!saved.ok && saved.code === "BAD_ID") return [400, toContractError(saved)];
      store.setDealState(id, advanced.deal.state);
      emit({ type: "STATE", dealId: id, from: advanced.event.from, to: advanced.event.to });
      emit({ type: "DELIVERY_RECORDED", dealId: id, deliveryId: merged.id, status: merged.status });
      if (advanced.deal.state === "SETTLED") {
        const paid = settle(ledger, id, deal.seller);
        if (!paid.ok) return [400, toContractError(paid)];
        emit({ type: "SETTLED", dealId: id, paid: paid.paid });
      } else if (advanced.deal.state === "REJECTED") {
        const back = refund(ledger, id);
        if (!back.ok) return [400, toContractError(back)];
        emit({ type: "REFUNDED", dealId: id, refunded: back.refunded });
      }
      const current = store.getDeal(id);
      return [
        200,
        {
          ok: true,
          state: current.state,
          allowedMoves: movesFor(current.state),
          result: { delivery: { id: merged.id, dealId: id, status: merged.status } },
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
      const deal = pathname.match(/^\/api\/deals\/([^/]+)$/);
      if (deal !== null && method === "GET" && decodeURIComponent(deal[1]) !== "") {
        return [handlers["GET /api/deals/:id"], decodeURIComponent(deal[1])];
      }
    }
    return [undefined, undefined];
  };

  const server = http.createServer(async (req, res) => {
    // Correlation first: everything this request logs, including failures
    // in the Schema/Referee/Ledger stages below, carries this ID.
    const correlationId = randomUUID();
    req.correlationId = correlationId;
    req.log = logger.child({ correlationId });
    req.log.info({ method: req.method, url: req.url }, "request.in");
    const send = (status, payload) => {
      const text = JSON.stringify(payload);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
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
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      const method = (req.method ?? "GET").toUpperCase();
      const [handler, id] = match(method, pathname);
      if (handler === undefined) {
        reject(404, error("NOT_FOUND", `no route for ${method} ${pathname}`));
        return;
      }
      if (method === "POST") {
        const key = req.headers["idempotency-key"];
        if (typeof key !== "string" || key.length === 0) {
          reject(400, error("MISSING_IDEMPOTENCY_KEY", "POST requests require an Idempotency-Key header"));
          return;
        }
        const replay = idempotency.get(key);
        if (replay !== undefined) {
          send(replay.status, replay.payload);
          return;
        }
        let body;
        try {
          const text = await readBody(req);
          body = text.length === 0 ? {} : JSON.parse(text);
        } catch {
          reject(400, error("INVALID_JSON", "request body must be valid JSON"));
          return;
        }
        const [status, payload] = handler(body, id);
        // Cache successes only: caching a rejection would freeze the first
        // error in place and punish clients that retry with a fixed request.
        if (payload.ok === true) idempotency.set(key, { status, payload });
        if (payload.ok === false) req.log.warn({ status, code: payload.error?.code }, "request.rejected");
        send(status, payload);
        return;
      }
      const [status, payload] = handler(undefined, id);
      if (payload.ok === false) req.log.warn({ status, code: payload.error?.code }, "request.rejected");
      send(status, payload);
    } catch (err) {
      req.log.error({ err }, "request.crashed");
      send(500, error("INTERNAL", err?.message ?? "internal server error"));
    }
  });

  return { server, store, ledger };
}

export function startServer({ dbPath, port = 0 } = {}) {
  const { server, store } = createApp(dbPath);
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
              store.close();
              done();
            });
          }),
      });
    });
  });
}
