// Brick 5: HTTP endpoints. node:http with no framework.
//
// Every request runs the same pipeline in this order:
// schema -> referee -> deal state -> ledger. Stages that do not apply to an
// endpoint pass through. Every response uses the contract shape:
//   { ok: true, state, allowedMoves, result }
//   { ok: false, error: { code, message } }
// Every POST accepts an optional Idempotency-Key header; a repeated key
// replays the stored success response without re-executing the request.
// When the header is missing, the server auto-generates a deterministic
// key from agent + URL + body with a short TTL, so agent retries are safe
// without agents ever handling HTTP plumbing themselves.
//
// Funding model: opening a deal deposits its price into the buyer's ledger
// balance, so the later ACCEPT lock can succeed. Registering an agent
// ensures the agent owns a (possibly zero) ledger balance entry, which
// settle requires of the seller.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import helmet from "helmet";
import { logger } from "./logger.js";
import { openStore } from "./db.js";
import { createSessionManager } from "./session-manager.js";
import { AUTO_IDEMPOTENCY_TTL_MS, EVENT_CAP, IDEMPOTENCY_SWEEP_MS, IDEMPOTENCY_TTL_MS, MAX_BODY_SIZE, isDemoSafe, isAutoApprove, probationPriceCap, probationMaxDeals, registrationPerIpPerHour, negotiationWindowMs, inspectionTimeoutMs, deliverySlaBounds } from "./config.js";
import { buildOpenApi, buildLlmsTxt, buildAgentJson } from "./openapi.js";

// Pure reaper for the idempotency map: explicit-key entries older than
// ttlMs are dropped, auto-generated entries older than the short auto TTL
// are dropped. Exported so tests can prove the TTL policy without waiting.
// Deterministic auto key for headerless POSTs: agents never handle HTTP
// plumbing, but an identical retry within the auto window still replays
// the cached result instead of re-executing the request.
export function autoIdempotencyKey(scope, url, bodyText) {
  return `auto:${createHash("sha256").update(`${scope}:${url}:${bodyText}`).digest("hex")}`;
}
export function pruneIdempotency(map, now, ttlMs) {
  for (const [key, entry] of map) {
    const ttl = entry.auto === true ? AUTO_IDEMPOTENCY_TTL_MS : ttlMs;
    if (entry.at < now - ttl) map.delete(key);
  }
}

// Registration anti-spam window and safety cap. The window matches the
// hourly check below; the cap bounds the map when X-Forwarded-For values
// are spoofed faster than the sweep can prune them.
export const REG_ATTEMPT_WINDOW_MS = 60 * 60 * 1000;
export const MAX_REG_IPS = 10000;

// Pure reaper for the regAttempts map: an IP survives only while at least
// one of its timestamps falls inside the window (same strict bound as the
// request-path filter). Exported so tests can prove the hourly policy
// without waiting an hour.
export function pruneRegAttempts(map, now, windowMs) {
  for (const [ip, stamps] of map) {
    if (!Array.isArray(stamps) || !stamps.some((at) => at > now - windowMs)) map.delete(ip);
  }
}

// Hard bound for the regAttempts map: evict oldest-first (Maps preserve
// insertion order) so a spoofed-IP flood cannot grow memory without bound
// between sweeps. At most one eviction per insert keeps this O(1).
export function capRegAttempts(map, maxIps) {
  while (map.size > maxIps) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

// Boot recovery: the ledger is in-memory but deals are SQLite, so a restart
// vaporizes escrow. Replay every live lock in creation (rowid) order: each
// deal past acceptance re-deposits its price into the buyer's balance
// (mirroring POST /api/deals) and re-locks it. NEGOTIATING deals hold no
// lock by design and are skipped. Per-deal try/catch so one corrupt row
// cannot abort the rest; every outcome is returned for the caller to log.
export function reconcileLedger({ store, ledger }) {
  const LOCKED_STATES = new Set(["AGREED", "ESCROW_LOCKED", "EXECUTING", "DELIVERED", "VERIFYING"]);
  const outcomes = [];
  for (const deal of store.listDeals()) {
    if (!LOCKED_STATES.has(deal.state)) continue;
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
import { inspectorMode } from "./meta-brain.js";
import { syncProfile, syncAgentRegistration, syncAgentStatus, syncAgentEmails } from "./supabase-sync.js";
import { supabaseAdmin } from "./supabase.js";
import { validate as validateReferee } from "../src/referee.js";
import { allowedMoves } from "../src/menu.js";
import { EDGES, transition } from "../src/deal-states.js";
import { createLedger, deposit, lock, refund } from "../src/ledger.js";

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
  const out = error(normalizeErrorCode(result.code), result.message);
  // Referee price rejections carry machine-readable bounds; every other
  // envelope leaves the field absent so the contract never gains nulls.
  if (result.bounds !== undefined) out.bounds = result.bounds;
  return out;
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

// Turn hint for agent loops: which side the caller is on, and whose action
// the deal is waiting for. waitingOn names a role ("buyer"/"seller"),
// "either" while both sides can move, "inspector" while the verdict is
// pending, and "none" once terminal. Every rejection below carries this
// alongside state/allowedMoves so an LLM can self-correct in one round trip.
const WAITING_ON = {
  NEGOTIATING: "either",
  AGREED: "buyer",
  ESCROW_LOCKED: "seller",
  EXECUTING: "seller",
  DELIVERED: "seller",
  VERIFYING: "inspector",
  SETTLED: "none",
  REJECTED: "none",
};

function turnContext(deal, agent) {
  const yourRole =
    agent !== undefined && agent !== null
      ? agent.id === deal.seller
        ? "seller"
        : agent.id === deal.buyer
          ? "buyer"
          : null
      : null;
  return { yourRole, waitingOn: WAITING_ON[deal.state] ?? "none" };
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

// Verdict surface: a derived, ISO-8601 summary of where a deal stands and
// why. Pure function so the mapping is unit-testable; the handler only
// attaches it. Additive — the frozen deal row shape never changes.
export function buildVerdict(deal, row) {
  const toIso = (ms) => (typeof ms === "number" ? new Date(ms).toISOString() : null);
  const toIsoSeconds = (s) => (typeof s === "number" ? new Date(s * 1000).toISOString() : null);
  let status = "PENDING";
  let verdict_reason = "Deal in progress.";
  if (deal.state === "SETTLED") {
    status = "SETTLED";
    verdict_reason = "Escrow released to the seller on verified delivery.";
  } else if (deal.state === "REJECTED") {
    if (typeof row?.close_reason === "string" && row.close_reason.includes("TIMEOUT")) {
      status = "EXPIRED";
      verdict_reason = `Expired (${row.close_reason}) — buyer refunded.`;
    } else {
      status = "REJECTED";
      verdict_reason = "Delivery rejected — buyer refunded.";
    }
  } else if (deal.state === "VERIFYING") {
    status = "FROZEN";
    verdict_reason = "Awaiting inspector verdict — escrow locked.";
  }
  return {
    status,
    close_reason: row?.close_reason ?? null,
    verdict_reason,
    timestamps: {
      created: toIsoSeconds(row?.created_at),
      updated: toIso(row?.updated_at),
      expires: toIso(row?.expires_at),
      delivery_expires: toIso(row?.delivery_expires_at),
    },
  };
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
  // Boot recovery runs before the first request: any rows past acceptance
  // left by a previous process get their in-memory locks replayed, so
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
  // DEMO_SAFE=true freezes background expiry for the whole process.
  // Read here at boot (not at import) so tests can flip the env per case.
  const demoSafe = isDemoSafe();
  const sessions = createSessionManager({
    store,
    ledger,
    demoSafe,
    expiresInMs: negotiationWindowMs(),
    inspectionExpiresInMs: inspectionTimeoutMs(),
  });
  // Opt-in permissionless onboarding: read at boot like demoSafe.
  const autoApprove = isAutoApprove();
  // Registration anti-spam: in-memory per-IP hourly window, only enforced
  // when AUTO_APPROVE is on (the manual queue is its own throttle).
  const regAttempts = new Map();
  const clientIp = (req) => {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length > 0) {
      return forwarded.split(",")[0].trim() || "unknown";
    }
    return req.socket?.remoteAddress ?? "unknown";
  };
  const checkRegistrationCap = (req) => {
    const cap = registrationPerIpPerHour();
    const now = Date.now();
    const windowStart = now - REG_ATTEMPT_WINDOW_MS;
    const ip = clientIp(req);
    const recent = (regAttempts.get(ip) ?? []).filter((at) => at > windowStart);
    if (recent.length >= cap) return false;
    recent.push(now);
    regAttempts.set(ip, recent);
    // Spoofed-IP flood guard on the insert path: one oldest-first eviction
    // per insert keeps the map bounded even between sweeps.
    capRegAttempts(regAttempts, MAX_REG_IPS);
    return true;
  };
  const events = [];
  const idempotency = new Map();
  // Entries carry their write time; anything older than the TTL is reaped
  // on a slow unref'd interval so the map cannot grow for the life of the
  // process. Unref'd like the session sweeper: a forgotten app never holds
  // the event loop open on its own.
  const idemSweep = setInterval(() => {
    try {
      pruneIdempotency(idempotency, Date.now(), IDEMPOTENCY_TTL_MS);
      // The registration tracker rides the same unref'd tick: hourly
      // entries age out here, and the cap trims any spoofed-IP surplus
      // the insert path could not evict on its own.
      pruneRegAttempts(regAttempts, Date.now(), REG_ATTEMPT_WINDOW_MS);
      capRegAttempts(regAttempts, MAX_REG_IPS);
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

  // Live SSE subscribers: one entry per open /api/admin/events/stream
  // connection. Fan-out is best-effort — a dead client is pruned, never
  // allowed to break emit() for the pipeline.
  const sseClients = new Set();
  // Per-agent streams: agentId -> Set of { res }. Same best-effort rule;
  // each entry only ever receives its own agent's deal events.
  const agentStreams = new Map();
  const MAX_AGENT_STREAMS = 2;
  const streamMatches = (agentId, event) => {
    if (event.dealId === undefined || event.dealId === null) return true;
    const deal = store.getDeal(event.dealId);
    return deal !== null && (deal.buyer === agentId || deal.seller === agentId);
  };
  const closeAgentStreams = (agentId) => {
    const set = agentStreams.get(agentId);
    if (set === undefined) return;
    for (const entry of set) {
      try {
        entry.res.end();
      } catch {
        // Already gone: dropping the handle is the whole job.
      }
    }
    agentStreams.delete(agentId);
  };
  // Shutdown helper: end EVERY SSE response (agent feeds and the admin
  // feed). server.close() only stops new connections and waits for open
  // ones; an SSE socket never ends on its own, so without this a redeploy
  // (SIGTERM -> close()) hangs until the platform SIGKILLs it.
  const closeAllStreams = () => {
    for (const set of agentStreams.values()) {
      for (const entry of set) {
        try {
          entry.res.end();
        } catch {
          // Best effort: already-gone sockets are fine.
        }
      }
    }
    agentStreams.clear();
    for (const res of sseClients) {
      try {
        res.end();
      } catch {
        // Best effort: already-gone sockets are fine.
      }
    }
    sseClients.clear();
  };
  const emit = (event) => {
    seq += 1;
    const full = { seq, at: Date.now(), ...event };
    events.push(full);
    // Bounded like traffic: the feed keeps the newest EVENT_CAP rows while
    // the monotonic seq survives the drop, so consumers can see the gap.
    if (events.length > EVENT_CAP) events.splice(0, events.length - EVENT_CAP);
    const line = `data: ${JSON.stringify(full)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(line);
      } catch {
        sseClients.delete(client);
      }
    }
    for (const [agentId, set] of agentStreams) {
      if (!streamMatches(agentId, full)) continue;
      for (const entry of set) {
        try {
          entry.res.write(`id: ${full.seq}\n${line}`);
        } catch {
          set.delete(entry);
        }
      }
      if (set.size === 0) agentStreams.delete(agentId);
    }
  };

  // Expiry is a protocol event, not just a row update: the console's deal
  // table and traffic feed stay truthful when a negotiation dies quietly.
  // Shared by the timer path and the manual demo-sweep endpoint so a
  // forced sweep produces identical events and logs.
  const handleSweepOutcomes = (outcomes, tag) => {
    for (const outcome of outcomes) {
      if (outcome.to === "REJECTED") {
        emit({ type: "STATE", dealId: outcome.id, from: outcome.from, to: "REJECTED", reason: outcome.reason ?? "EXPIRED_TIMEOUT" });
      }
    }
    if (outcomes.length > 0) logger.info({ outcomes }, tag);
  };
  sessions.start((outcomes) => handleSweepOutcomes(outcomes, "session.sweep"));

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

  const refereeContext = (deal, agent) => {
    const rows = store.listMoves(deal.id);
    const offers = rows.filter((row) => row.kind === "OFFER");
    // The moving agent's own side decides which price rule binds: buyers
    // are capped by what they can lock, sellers by their listing floor.
    // Endpoints and compute are strict (price is the floor); negotiation
    // services use min_price so custom work can settle below list.
    const role = agent !== undefined && agent !== null && agent.id === deal.seller ? "seller" : "buyer";
    // Snapshot-first pricing: a deal negotiates under the listing as it
    // stood at open. Pre-snapshot rows (NULL columns) fall back to the live
    // listing so nothing breaks on old databases.
    const listing = store.getDealSnapshot(deal.id) ?? store.getAgentDetail(deal.seller);
    const listingPrice = listing?.price;
    const serviceType = listing?.service_type ?? "negotiation";
    return {
      state: deal.state,
      role,
      budget: ledger.balances[deal.buyer] ?? deal.price,
      // Seller floor follows the service strategy: fixed-price listings
      // hold list, negotiable ones hold min_price (1 when unset, which any
      // positive price clears — sellers without listings negotiate exactly
      // as before).
      floor: serviceType === "negotiation"
        ? (Number.isInteger(listing?.min_price) ? listing.min_price : 1)
        : (Number.isInteger(listingPrice) ? listingPrice : 1),
      // Standing offer both sides negotiate against; null before the first
      // OFFER lands.
      last_offer: offers.length > 0 ? offers[offers.length - 1].price : null,
      seenKeys: rows.map((row) => row.key),
      // OFFER prices only: ACCEPTs are agreements, not offers, and must
      // never trip DUPLICATE_OFFER (see the referee rule).
      seenOffers: offers.map((row) => row.price),
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
    // is selling, what they sell, and how much stake they hold. Discovery
    // filters keep the response token-efficient: an agent narrows by skill,
    // strategy, and ceiling instead of scraping the whole directory.
    // Existing list fields are unchanged (the console renders them), the
    // strategy columns ride alongside.
    "GET /api/agents": (_body, _id, _agent, query = {}) => {
      const skill = typeof query?.skill === "string" && query.skill.length > 0 ? query.skill : undefined;
      const rawType = typeof query?.service_type === "string" ? query.service_type : "";
      if (rawType !== "" && !["endpoint", "negotiation", "compute"].includes(rawType)) {
        return [400, error("INVALID_SCHEMA", "field service_type must be one of: endpoint, negotiation, compute")];
      }
      const service_type = rawType === "" ? undefined : rawType;
      let max_price;
      if (query?.max_price !== undefined && query.max_price !== "") {
        const n = Number(query.max_price);
        if (!Number.isInteger(n) || n < 1) {
          return [400, error("INVALID_SCHEMA", "field max_price must be a positive integer")];
        }
        max_price = n;
      }
      return [200, { ok: true, state: null, allowedMoves: [], result: { agents: store.listAgents({ skill, service_type, max_price }) } }];
    },

    // Public: how a registered agent polls its own lifecycle outcome.
    "GET /api/agents/:id/status": (_body, id) => {
      const review = store.getAgentStatus(id);
      if (review === null) return [404, error("NO_SUCH_AGENT", `no agent with id ${id}`)];
      return [200, { ok: true, state: null, allowedMoves: [], result: review }];
    },

    // Public Trust Passport: Supabase profile first (email, owner, joined
    // date), SQLite fallback when the replica is unreachable. The fallback
    // shape is the already-public getAgent + status — api_key can never
    // appear here by construction (neither reader carries it). Async: the
    // dispatcher awaits handlers, so sync handlers are unaffected.
    "GET /api/agents/:id/profile": async (_body, id) => {
      const local = store.getAgent(id);
      if (local === null) return [404, error("NO_SUCH_AGENT", `no agent with id ${id}`)];
      const fallback = () => {
        // Listing fields come from the admin list, picked down to the
        // public subset — same fields GET /api/agents already exposes.
        const full = store.listAllAgents().find((row) => row.id === id);
        const status = store.getAgentStatus(id);
        return [200, { ok: true, state: null, allowedMoves: [], result: {
          agent_id: id,
          role: local.role,
          capability: full?.capability ?? null,
          title: full?.title ?? null,
          description: full?.description ?? null,
          price: Number.isInteger(full?.price) ? full.price : null,
          category: full?.category ?? null,
          status: status?.status ?? null,
          email: null,
          owner_email: null,
          joined: null,
          source: "sqlite",
        } }];
      };
      const client = supabaseAdmin();
      if (client === null) return fallback();
      const fetched = await client.fetchProfile(id);
      if (!fetched.ok) return fallback();
      const p = fetched.profile;
      return [200, { ok: true, state: null, allowedMoves: [], result: {
        agent_id: id,
        role: p.role ?? local.role,
        capability: p.capability ?? null,
        title: p.title ?? null,
        description: p.description ?? null,
        price: Number.isInteger(p.price) ? p.price : null,
        category: p.category ?? null,
        status: p.status ?? null,
        email: p.email ?? null,
        owner_email: p.owner_email ?? null,
        joined: p.created_at ?? null,
        source: "supabase",
      } }];
    },

    // Self-serve identity linking: the caller's key must belong to the URL
    // id (the dispatcher resolves the agent for this route, like deals),
    // so no agent can attach email to another agent. Writes Supabase
    // only — SQLite holds no emails. A dead replica answers 503 while the
    // rest of the protocol keeps working.
    "POST /api/agents/:id/link-email": async (body, id, agent) => {
      const checked = validateSchema("linkEmail", body);
      if (!checked.ok) return [400, toContractError(checked)];
      const emailRe = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
      if (!emailRe.test(body.email) || !emailRe.test(body.owner_email)) {
        return [400, error("INVALID_SCHEMA", "field email must be a valid email address")];
      }
      if (agent === null || agent.id !== id) {
        return [403, error("FORBIDDEN", `only agent ${id} can link its own email`)];
      }
      const linked = await syncAgentEmails(id, { email: body.email, owner_email: body.owner_email });
      if (!linked.ok) {
        return [503, error("SUPABASE_UNAVAILABLE", "email linking is temporarily unavailable")];
      }
      return [200, { ok: true, state: null, allowedMoves: [], result: { agent_id: id, linked: true } }];
    },

    // Credential rotation: the caller's key must belong to the URL id (the
    // dispatcher resolves the agent for this route, like deals). One atomic
    // UPDATE swaps the key; the old one stops resolving immediately. The new
    // key is shown once, and idempotent replay returns the same key.
    "POST /api/agents/:id/rotate-key": (body, id, agent) => {
      const checked = validateSchema("rotateKey", body);
      if (!checked.ok) return [400, toContractError(checked)];
      if (agent === null || agent.id !== id) {
        return [403, error("FORBIDDEN", `only agent ${id} can rotate its own key`)];
      }
      const rotated = store.rotateAgentKey(id);
      if (!rotated.ok) {
        const status = rotated.code === "NO_SUCH_AGENT" ? 404 : 400;
        return [status, toContractError(rotated)];
      }
      // A rotated credential must not keep old streams alive.
      closeAgentStreams(id);
      return [200, { ok: true, state: null, allowedMoves: [], result: { agent_id: id, api_key: rotated.api_key } }];
    },

    // Owner-only self profile: id, role, lifecycle, probation, balance,
    // and open-deal counts. Never another agent's row.
    "GET /api/me": (_body, _id, agent) => {
      if (agent === null) {
        return [401, error("UNAUTHORIZED", "reading your own profile requires a valid x-agent-key header")];
      }
      const status = store.getAgentStatus(agent.id);
      // The ledger is authoritative for money: agents.balance in SQLite is
      // written once at registration and never updated, so it would lie.
      // locked sums this agent's funded escrows so the caller sees both
      // numbers it needs to reason about funding capacity.
      const locked = Object.values(ledger.locks).reduce(
        (sum, escrow) => sum + (escrow.agentId === agent.id ? escrow.amount : 0),
        0,
      );
      return [
        200,
        {
          ok: true,
          state: null,
          allowedMoves: [],
          result: {
            id: agent.id,
            role: agent.role,
            status: status?.status ?? null,
            status_reason: status?.status_reason ?? null,
            probation: store.getAgentProbation(agent.id) ?? 0,
            balance: ledger.balances[agent.id] ?? 0,
            locked,
            deals: {
              open: store.countOpenDealsByParty(agent.id),
              total: store.countDealsByParty(agent.id),
            },
          },
        },
      ];
    },

    // Legacy alias: early clients sent speech_transcription; the canonical
    // category is speech. Normalized on write; reads always see canonical.
    "POST /api/agents": (body, _id, _agent, req) => {
      const checked = validateSchema("registerAgent", body);
      if (!checked.ok) return [400, toContractError(checked)];
      if (store.getAgent(body.id) !== null) {
        return [409, error("DUPLICATE_AGENT", `agent ${body.id} is already registered`)];
      }
      // Open registration is spam-gated only in auto-approve mode; the
      // manual review queue is its own throttle.
      if (autoApprove && !checkRegistrationCap(req)) {
        return [429, error("RATE_LIMITED", "too many registrations from this address; try again later")];
      }
      const category = body.category === "speech_transcription" ? "speech" : body.category;
      // Listing strategy: absent means a negotiable service, so every
      // existing payload keeps its behavior. New fields ride straight
      // into the store; the schema already bound their shapes.
      const serviceType = body.service_type ?? "negotiation";
      // Deployment-tightened SLA bounds ride beside the wide static
      // schema range; out-of-env values are a schema-shaped 400.
      const sla = deliverySlaBounds();
      const slaSeconds = body.delivery_sla_seconds ?? sla.def;
      if (slaSeconds < sla.min || slaSeconds > sla.max) {
        return [400, error("INVALID_SCHEMA", `field delivery_sla_seconds must be between ${sla.min} and ${sla.max} seconds`)];
      }
      // getAgent's column list is frozen for existing readers, so the
      // agent shape stays { id, role, balance }; the credential rides
      // beside it, shown once like a Stripe secret key.
      const apiKey = randomUUID();
      const probation = autoApprove ? 1 : 0;
      const status = autoApprove ? "ACTIVE" : "PENDING";
      store.saveAgent({ id: body.id, role: body.role, balance: 0, capability: body.capability, title: body.title, description: body.description, price: body.price, category, api_key: apiKey, status, probation, delivery_sla_seconds: slaSeconds, service_type: serviceType, min_price: body.min_price ?? null, skills: body.skills, metadata: body.metadata });
      ensureAccount(body.id);
      emit({ type: "AGENT_REGISTERED", agentId: body.id, role: body.role });
      // Outbound replica only: after the SQLite commit, never awaited, so
      // a Supabase outage stales discovery without failing registration.
      syncAgentRegistration({ id: body.id, role: body.role, balance: 0, capability: body.capability, status, title: body.title, description: body.description, price: body.price, category }).catch(() => {});
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
            message: autoApprove
              ? "Agent registered successfully and listed with probation caps."
              : "Agent registered successfully. Your listing is currently in the review queue.",
            api_key: apiKey,
            probation,
          },
        },
      ];
    },

    // Probation caps: a probation agent — buyer or seller — may only deal
    // within the price cap and the concurrent-deal cap. Graduated and
    // legacy agents skip both checks.
    "POST /api/deals": (body, _id, agent) => {
      const checked = validateSchema("openDeal", body);
      if (!checked.ok) return [400, toContractError(checked)];
      // Either counterparty may open; anyone else is a bystander.
      if (agent.id !== body.buyer && agent.id !== body.seller) {
        return [403, error("FORBIDDEN", `agent ${agent.id} is not a party of this deal`)];
      }
      // Commerce integrity: only ACTIVE agents trade. PENDING listings wait
      // in the review queue, and REJECTED/SUSPENDED/RETIRED (or unknown)
      // agents are out of the market entirely — in-flight deals of
      // sanctioned agents keep settling, but no new deal may name them.
      for (const [label, party] of [["buyer", body.buyer], ["seller", body.seller]]) {
        if (store.getAgentStatus(party)?.status !== "ACTIVE") {
          return [403, error("FORBIDDEN", `${label} ${party} is not ACTIVE`)];
        }
      }
      // Option C ids: omitted ids are server-issued (`deal-<8hex>`);
      // explicit client ids keep working unchanged. Idempotency still
      // dedupes the retry, returning the same issued id.
      const dealId = body.id ?? `deal-${randomUUID().slice(0, 8)}`;
      if (store.getDeal(dealId) !== null) {
        return [409, error("DUPLICATE_DEAL", `deal ${dealId} already exists`)];
      }
      for (const party of [body.buyer, body.seller]) {
        if (store.getAgentProbation(party) === 1) {
          if (body.price > probationPriceCap()) {
            return [403, error("PROBATION_LIMIT", `probation agents may not open deals above ${probationPriceCap()} CR`)];
          }
          if (store.countOpenDealsByParty(party) >= probationMaxDeals()) {
            return [403, error("PROBATION_LIMIT", `probation agents may hold at most ${probationMaxDeals()} open deals`)];
          }
        }
      }
      ensureAccount(body.buyer);
      ensureAccount(body.seller);
      const funded = deposit(ledger, body.buyer, body.price);
      if (!funded.ok) return [400, toContractError(funded)];
      // The negotiation window starts the moment the deal opens; the
      // sweeper reads this stamp, and NULL (pre-timeout rows) never expires.
      // sla_ms snapshots the seller's listing SLA so later listing edits
      // never change a running deal's delivery deadline.
      const slaSeconds = store.getAgentSla(body.seller) ?? deliverySlaBounds().def;
      // Negotiation rules ride the deal like the SLA snapshot: the floor and
      // strategy in force at open, so later listing edits cannot rewrite a
      // running negotiation (see refereeContext).
      const openListing = store.getAgentDetail(body.seller);
      store.saveDeal({ id: dealId, state: "NEGOTIATING", buyer: body.buyer, seller: body.seller, price: body.price, expires_at: sessions.expiresAt(), sla_ms: slaSeconds * 1000, metadata: body.metadata, snapshot_service_type: openListing?.service_type ?? "negotiation", snapshot_min_price: Number.isInteger(openListing?.min_price) ? openListing.min_price : null, snapshot_listing_price: Number.isInteger(openListing?.price) ? openListing.price : null });
      emit({ type: "DEAL_OPENED", dealId, state: "NEGOTIATING" });
      const deal = store.getDeal(dealId);
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
      const ruled = validateReferee(move, refereeContext(deal, agent));
      if (!ruled.ok) {
        // Context-aware rejection: the agent learns the deal state, its
        // legal replies, and the exact numeric bounds in one round trip.
        const [status, payload] = stageError(ruled);
        return [status, { ...payload, state: deal.state, allowedMoves: movesFor(deal.state), ...turnContext(deal, agent) }];
      }
      let next = null;
      if (merged.kind === "ACCEPT") {
        const advanced = transition(deal, "AGREED");
        if (!advanced.ok) {
          const [status, payload] = stageError(advanced);
          return [status, { ...payload, state: deal.state, allowedMoves: movesFor(deal.state), ...turnContext(deal, agent) }];
        }
        next = advanced;
      }
      // Lock BEFORE anything is persisted: AGREED must imply funds locked. A
      // failed lock returns here with no move recorded and no state changed,
      // so the deal stays NEGOTIATING and the key remains reusable. The
      // duplicate-key check rides ahead of the lock so a consumed key replays
      // its 409 instead of locking funds for a move that can never be saved
      // (the handler is synchronous to this point, so the precheck holds).
      if (next !== null) {
        if (store.listMoves(id).some((row) => row.key === merged.key)) {
          return [409, { ...error("DUPLICATE_MOVE", `move key ${merged.key} was already stored for deal ${id}`), state: deal.state, allowedMoves: movesFor(deal.state), ...turnContext(deal, agent) }];
        }
        const locked = lock(ledger, deal.buyer, id, merged.price);
        if (!locked.ok) return [400, { ...toContractError(locked), state: deal.state, allowedMoves: movesFor(deal.state), ...turnContext(deal, agent) }];
      }
      const saved = store.saveMove({
        id: `${id}:${merged.key}`,
        deal_id: id,
        key: merged.key,
        kind: merged.kind,
        price: merged.price ?? null,
      });
      if (!saved.ok) return [409, { ...toContractError(saved), state: deal.state, allowedMoves: movesFor(deal.state), ...turnContext(deal, agent) }];
      emit({ type: "MOVE_RECORDED", dealId: id, key: merged.key, kind: merged.kind });
      if (next !== null) {
        store.setDealState(id, next.deal.state);
        emit({ type: "STATE", dealId: id, from: next.event.from, to: next.event.to });
        emit({ type: "ESCROW_LOCKED", dealId: id, amount: merged.price });
      }
      const current = store.getDeal(id);
      return [
        200,
        {
          ok: true,
          state: current.state,
          allowedMoves: movesFor(current.state),
          ...turnContext(current, agent),
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
      // Buyer-only capture: the seller never captures escrow, even though
      // they are a party. The lock holds buyer funds; only the buyer may
      // authorize the capture handshake.
      if (agent.id !== deal.buyer) {
        return [403, error("FORBIDDEN", `only the buyer can capture escrow for deal ${id}`)];
      }
      if (deal.state === "NEGOTIATING") {
        return [402, { ...error("NEEDS_ACCEPTANCE", `deal ${id} has no accepted price to pay yet`), state: deal.state, allowedMoves: movesFor(deal.state), ...turnContext(deal, agent) }];
      }
      if (deal.state !== "AGREED") {
        return [409, { ...error("ALREADY_LOCKED", `deal ${id} is ${deal.state}; its single escrow lock already happened`), state: deal.state, allowedMoves: movesFor(deal.state), ...turnContext(deal, agent) }];
      }
      if (ledger.locks[id] === undefined) {
        const locked = lock(ledger, deal.buyer, id, deal.price);
        if (!locked.ok) return [400, { ...toContractError(locked), state: deal.state, allowedMoves: movesFor(deal.state), ...turnContext(deal, agent) }];
      }
      const advanced = transition(deal, "ESCROW_LOCKED");
      if (!advanced.ok) {
        const [status, payload] = stageError(advanced);
        return [status, { ...payload, state: deal.state, allowedMoves: movesFor(deal.state), ...turnContext(deal, agent) }];
      }
      store.setDealState(id, advanced.deal.state);
      // Truthful amount: the lock is authoritative, whether ACCEPT funded it
      // at a discounted price or pay just locked the full deal price. Both
      // paths above guarantee a lock exists here (failures return early).
      emit({ type: "ESCROW_LOCKED", dealId: id, amount: ledger.locks[id].amount });
      // Capture starts the delivery clock from the deal's own SLA
      // snapshot: a seller who never delivers after this stamp loses the
      // lock to the delivery sweeper. Pre-snapshot rows fall back to the
      // env default, matching open-time behavior for new listings.
      store.setDealDeliveryExpiry(id, Date.now() + (store.getDealRow(id)?.sla_ms ?? deliverySlaBounds().def * 1000));
      // A real-looking receipt: the client proves capture with this string,
      // the server proves it with the matching ledger lock.
      const receipt = `x402-receipt-${randomUUID()}`;
      const current = store.getDeal(id);
      return [
        200,
        { ok: true, state: current.state, allowedMoves: movesFor(current.state), ...turnContext(current, agent), result: { deal: current, receipt } },
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
        return [409, { ...error("MUST_PAY_BEFORE_DELIVERY", `deal ${id} is ${deal.state}; delivery requires a paid escrow`), state: deal.state, allowedMoves: movesFor(deal.state), ...turnContext(deal, agent) }];
      }
      try {
        const saved = store.saveDelivery({ id: merged.id, deal_id: id, status: null, delivery_url: merged.deliveryUrl });
        if (!saved.ok) {
          if (saved.code === "DUPLICATE_DELIVERY") return [409, { ...toContractError(saved), state: deal.state, allowedMoves: movesFor(deal.state), ...turnContext(deal, agent) }];
          if (saved.code === "BAD_ID") return [400, { ...toContractError(saved), state: deal.state, allowedMoves: movesFor(deal.state), ...turnContext(deal, agent) }];
          return [400, { ...toContractError(saved), state: deal.state, allowedMoves: movesFor(deal.state), ...turnContext(deal, agent) }];
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
      runInspection({ store, ledger, dealId: id, deliveryUrl: merged.deliveryUrl, capability: merged.capability, emit, log: logger }).catch((err) => {
        logger.error({ err, dealId: id }, "inspector.crashed");
      });
      const current = store.getDeal(id);
      return [
        202,
        {
          ok: true,
          state: current.state,
          allowedMoves: movesFor(current.state),
          ...turnContext(current, agent),
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

    "GET /api/deals/:id": (_body, id, agent) => {
      const deal = store.getDeal(id);
      if (deal === null) return [404, error("NO_SUCH_DEAL", `no deal with id ${id}`)];
      return [
        200,
        {
          ok: true,
          state: deal.state,
          allowedMoves: movesFor(deal.state),
          ...turnContext(deal, agent),
          // Live escrow for this deal, null once released or before any
          // lock: agents verify funds without correlating a second endpoint.
          result: { deal, moves: store.listMoves(id), verdict: buildVerdict(deal, store.getDealRow(id)), escrow: ledger.locks[id]?.amount ?? null },
        },
      ];
    },

    "GET /api/events": (_body, _id, agent) => {
      // Party scoping: an admin sees everything; a keyed agent sees
      // registry/system events (no dealId) plus only its own deals. This
      // keeps the global feed useful without leaking other agents' escrows.
      const visible = agent !== null && agent.id !== "admin"
        ? (() => {
          const dealCache = new Map();
          const isParty = (dealId) => {
            if (!dealCache.has(dealId)) {
              const deal = store.getDeal(dealId);
              dealCache.set(dealId, deal !== null && (deal.buyer === agent.id || deal.seller === agent.id));
            }
            return dealCache.get(dealId);
          };
          return events.filter((e) => e.dealId === undefined || e.dealId === null || isParty(e.dealId));
        })()
        : events;
      return [200, { ok: true, state: null, allowedMoves: [], result: { events: visible } }];
    },

    // Unauthenticated by design: load balancers and deploy gates need a
    // keyless liveness signal, and it reveals nothing.
    "GET /health": () => {
      return [200, { ok: true, state: null, allowedMoves: [], result: { status: "UP" } }];
    },

    // Machine-readable contract, generated from SCHEMAS at request time.
    "GET /openapi.json": () => {
      return [200, { ok: true, state: null, allowedMoves: [], result: buildOpenApi() }];
    },

    // Plain-language loop summary for agents and indexers.
    "GET /llms.txt": () => {
      return [200, { ok: true, state: null, allowedMoves: [], result: { text: buildLlmsTxt() } }];
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
          result: { stats: store.dealStats(), deals: store.listDeals(), logs: traffic.slice(-50), demoSafe, inspector: inspectorMode() },
        },
      ];
    },

    "GET /api/admin/agents": () => {
      return [200, { ok: true, state: null, allowedMoves: [], result: { agents: store.listAllAgents() } }];
    },

    "GET /api/admin/audit": () => {
      return [200, { ok: true, state: null, allowedMoves: [], result: { audit: audit.slice(-100) } }];
    },

    // Demo remote control: fire all three sweeps on demand and report what
    // moved. In demo-safe mode this is the ONLY way expiry runs; normally
    // it is a harmless duplicate of the next timer tick (sweeps are
    // idempotent — already-terminal rows are never reselected).
    "POST /api/admin/demo/sweep": () => {
      const groups = [
        ["sessions", sessions.sweepOnce()],
        ["deliveries", sessions.sweepDeliveries()],
        ["inspections", sessions.sweepInspections()],
      ];
      for (const [tag, outcomes] of groups) handleSweepOutcomes(outcomes, `demo.sweep.${tag}`);
      return [
        200,
        {
          ok: true,
          state: null,
          allowedMoves: [],
          result: {
            demoSafe,
            sweeps: Object.fromEntries(groups.map(([tag, outcomes]) => [tag, outcomes])),
          },
        },
      ];
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

    // Graduation: clears probation without touching lifecycle status.
    // Audit-logged like every moderation decision.
    "POST /api/admin/agents/:id/graduate": (body, id) => {
      const checked = validateSchema("graduateAgent", body);
      if (!checked.ok) return [400, toContractError(checked)];
      const cleared = store.setAgentProbation(id, 0);
      if (!cleared.ok) {
        const status = cleared.code === "NO_SUCH_AGENT" ? 404 : 400;
        return [status, toContractError(cleared)];
      }
      recordAudit({ action: "GRADUATE", agentId: id, from: null, to: null, reason: null });
      return [200, { ok: true, state: null, allowedMoves: [], result: { agent_id: id, probation: 0 } }];
    },

    // Operator detail: full row plus probation marker. The list shapes
    // stay frozen; this route is additive.
    "GET /api/admin/agents/:id": (_body, id) => {
      const row = store.getAgentDetail(id);
      if (row === null) return [404, error("NO_SUCH_AGENT", `no agent with id ${id}`)];
      return [200, { ok: true, state: null, allowedMoves: [], result: { agent: row } }];
    },

    // Operator edit: allowlisted partial update of listing fields. Unknown
    // fields are rejected by schema; empty patches by the store.
    "PATCH /api/admin/agents/:id": (body, id) => {
      const checked = validateSchema("patchAgent", body);
      if (!checked.ok) return [400, toContractError(checked)];
      if (body.category === "speech_transcription") body.category = "speech";
      const saved = store.updateAgent(id, body);
      if (!saved.ok) {
        const status = saved.code === "NO_SUCH_AGENT" ? 404 : 400;
        return [status, toContractError(saved)];
      }
      recordAudit({ action: "EDIT", agentId: id, from: null, to: null, reason: null });
      syncProfile(store.getAgentDetail(id)).catch(() => {});
      return [200, { ok: true, state: null, allowedMoves: [], result: store.getAgentStatus(id) }];
    },

    // Frozen-settlement recovery: a VERIFYING deal whose seller lost ACTIVE
    // standing can neither settle nor refund on its own. Force-refund
    // returns the locked escrow to the buyer and closes the deal as
    // operator-rejected; the seller is never paid on this path.
    "POST /api/admin/deals/:id/force-refund": (body, id) => {
      const deal = store.getDeal(id);
      if (deal === null) return [404, error("NO_SUCH_DEAL", `no deal with id ${id}`)];
      if (deal.state !== "VERIFYING") {
        return [409, { ...error("WRONG_STATE", `deal ${id} is ${deal.state}; force-refund requires a VERIFYING deal`), state: deal.state, allowedMoves: movesFor(deal.state), ...turnContext(deal, null) }];
      }
      const back = refund(ledger, id);
      if (!back.ok) {
        return [409, { ...toContractError(back), state: deal.state, allowedMoves: movesFor(deal.state), ...turnContext(deal, null) }];
      }
      store.setDealState(id, "REJECTED");
      store.setDealCloseReason(id, "ADMIN_FORCE_REFUND");
      emit({ type: "STATE", dealId: id, from: "VERIFYING", to: "REJECTED" });
      emit({ type: "REFUNDED", dealId: id, refunded: back.refunded });
      emit({ type: "SETTLEMENT_FROZEN_RESOLVED", dealId: id, resolution: "FORCE_REFUND" });
      const current = store.getDeal(id);
      return [200, { ok: true, state: current.state, allowedMoves: movesFor(current.state), ...turnContext(current, null), result: { deal: current, refunded: back.refunded, close_reason: "ADMIN_FORCE_REFUND" } }];
    },

    // Frozen-settlement recovery: re-run the inspector over the recorded
    // delivery. Settles normally when the seller is ACTIVE again (or
    // refunds on a negative verdict); stays frozen when the seller is
    // still suspended, answering 409 so the operator knows why.
    "POST /api/admin/deals/:id/reinspect": async (body, id) => {
      const deal = store.getDeal(id);
      if (deal === null) return [404, error("NO_SUCH_DEAL", `no deal with id ${id}`)];
      if (deal.state !== "VERIFYING") {
        return [409, { ...error("WRONG_STATE", `deal ${id} is ${deal.state}; reinspect requires a VERIFYING deal`), state: deal.state, allowedMoves: movesFor(deal.state), ...turnContext(deal, null) }];
      }
      const recorded = store.getDeliveryByDeal(id);
      if (recorded === null || typeof recorded.delivery_url !== "string") {
        return [409, { ...error("NO_DELIVERY", `deal ${id} has no recorded delivery to reinspect`), state: deal.state, allowedMoves: movesFor(deal.state), ...turnContext(deal, null) }];
      }
      const outcome = await runInspection({ store, ledger, dealId: id, deliveryUrl: recorded.delivery_url, capability: undefined, emit, log: logger });
      const current = store.getDeal(id);
      if (!outcome.ok) {
        const status = outcome.code === "SELLER_NOT_ACTIVE" ? 409 : 500;
        return [status, { ...error(outcome.code, outcome.message), state: current.state, allowedMoves: movesFor(current.state), ...turnContext(current, null) }];
      }
      emit({ type: "SETTLEMENT_FROZEN_RESOLVED", dealId: id, resolution: "REINSPECT", to: outcome.to });
      return [200, { ok: true, state: current.state, allowedMoves: movesFor(current.state), ...turnContext(current, null), result: { deal: current, to: outcome.to } }];
    },

    // Operator removal: guarded by the store (live deals refuse with 409).
    // Deal and move rows stay as audit history; only the agent row goes.
    "DELETE /api/admin/agents/:id": (_body, id) => {
      const removed = store.deleteAgent(id);
      if (!removed.ok) {
        const status = removed.code === "NO_SUCH_AGENT" ? 404 : 409;
        return [status, toContractError(removed)];
      }
      closeAgentStreams(id);
      recordAudit({ action: "DELETE", agentId: id, from: null, to: null, reason: null });
      return [200, { ok: true, state: null, allowedMoves: [], result: { id, deleted: true } }];
    },
  };

  function decideAgent(id, to, note) {
    const saved = store.setAgentStatus(id, to, note);
    if (!saved.ok) {
      const status = saved.code === "NO_SUCH_AGENT" ? 404 : 409;
      return [status, toContractError(saved)];
    }
    // Suspended or retired agents lose live streams: a lifecycle change
    // must not leave an open feed behind. Suspension is otherwise
    // visibility-only — deals, escrow, and balances keep working.
    if (to === "SUSPENDED" || to === "RETIRED") closeAgentStreams(id);
    recordAudit({ action: to, agentId: id, from: saved.from, to: saved.to, reason: note ?? null });
    // Replica follows the commit: status transitions propagate for
    // discovery filtering, failures isolated from moderation. Capability
    // rides along explicitly — neither narrow reader carries it.
    syncAgentStatus(id, to, note).catch(() => {});
    syncProfile(store.getAgentDetail(id)).catch(() => {});
    return [200, { ok: true, state: null, allowedMoves: [], result: store.getAgentStatus(id) }];
  }

  // Flat public/ directory only: no nested paths, no parent traversal, and
  // only the three types the site needs. Anything else falls through to
  // the JSON 404, so pages can never shadow an API route.
  const IMAGE_TYPES = new Set([".png", ".jpg", ".jpeg", ".svg"]);
  const STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
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
    const ext = path.extname(file).toLowerCase();
    const type = STATIC_TYPES[ext];
    if (type === undefined) return null;
    try {
      // Images travel as raw bytes: a UTF-8 decode would corrupt PNG/JPEG
      // payloads and break inspector evidence and browser renders alike.
      // Text assets keep the string path exactly as before.
      const body = IMAGE_TYPES.has(ext)
        ? fs.readFileSync(new URL(file, PUBLIC_DIR))
        : fs.readFileSync(new URL(file, PUBLIC_DIR), "utf8");
      return { type, body };
    } catch {
      return null;
    }
  };

  const match = (method, pathname) => {
    const direct = handlers[`${method} ${pathname}`];
    if (direct !== undefined) return [direct, undefined];
    if (
      method === "POST" ||
      method === "GET" ||
      ((method === "PATCH" || method === "DELETE" || method === "GET") && /^\/api\/admin\/agents\/[^/]+$/.test(pathname))
    ) {
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
      const agentProfile = pathname.match(/^\/api\/agents\/([^/]+)\/profile$/);
      if (agentProfile !== null && method === "GET" && decodeURIComponent(agentProfile[1]) !== "") {
        return [handlers["GET /api/agents/:id/profile"], decodeURIComponent(agentProfile[1])];
      }
      const linkEmail = pathname.match(/^\/api\/agents\/([^/]+)\/link-email$/);
      if (linkEmail !== null && method === "POST" && decodeURIComponent(linkEmail[1]) !== "") {
        return [handlers["POST /api/agents/:id/link-email"], decodeURIComponent(linkEmail[1])];
      }
      const rotateKey = pathname.match(/^\/api\/agents\/([^/]+)\/rotate-key$/);
      if (rotateKey !== null && method === "POST" && decodeURIComponent(rotateKey[1]) !== "") {
        return [handlers["POST /api/agents/:id/rotate-key"], decodeURIComponent(rotateKey[1])];
      }
      const moderation = pathname.match(/^\/api\/admin\/agents\/([^/]+)\/(approve|reject|suspend|retire|graduate)$/);
      if (moderation !== null && method === "POST" && decodeURIComponent(moderation[1]) !== "") {
        return [handlers[`POST /api/admin/agents/:id/${moderation[2]}`], decodeURIComponent(moderation[1])];
      }
      const forceRefund = pathname.match(/^\/api\/admin\/deals\/([^/]+)\/force-refund$/);
      if (forceRefund !== null && method === "POST" && decodeURIComponent(forceRefund[1]) !== "") {
        return [handlers["POST /api/admin/deals/:id/force-refund"], decodeURIComponent(forceRefund[1])];
      }
      const reinspect = pathname.match(/^\/api\/admin\/deals\/([^/]+)\/reinspect$/);
      if (reinspect !== null && method === "POST" && decodeURIComponent(reinspect[1]) !== "") {
        return [handlers["POST /api/admin/deals/:id/reinspect"], decodeURIComponent(reinspect[1])];
      }
      const agentEdit = pathname.match(/^\/api\/admin\/agents\/([^/]+)$/);
      if (agentEdit !== null && (method === "PATCH" || method === "DELETE" || method === "GET") && decodeURIComponent(agentEdit[1]) !== "") {
        return [handlers[`${method} /api/admin/agents/:id`], decodeURIComponent(agentEdit[1])];
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
      // The SSE stream authenticates below (header OR query token —
      // browsers cannot set headers on EventSource), so it skips the
      // header-only gate. Every other /api/admin/* path keeps it.
      const isStream = method === "GET" && pathname === "/api/admin/events/stream";
      if (pathname.startsWith("/api/admin/") && !isStream) {
        const denied = checkAdmin(req);
        if (denied !== null) {
          reject(401, denied);
          return;
        }
      }
      if (isStream) {
        // Query-token fallback: compared in constant time like the header.
        // loggedPath records pathname only, so the token never lands in
        // traffic logs; assume proxies may log URLs and rotate on leak.
        let authed = checkAdmin(req) === null;
        const secret = process.env.ADMIN_SECRET;
        if (!authed && typeof secret === "string" && secret.length > 0 && typeof query.token === "string") {
          const a = Buffer.from(`Bearer ${query.token}`);
          const b = Buffer.from(`Bearer ${secret}`);
          authed = a.length === b.length && timingSafeEqual(a, b);
        }
        if (!authed) {
          reject(401, error("UNAUTHORIZED", "valid admin credentials required"));
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(`: connected seq=${seq}\n\n`);
        sseClients.add(res);
        const heartbeat = setInterval(() => {
          try {
            res.write(`: ping\n\n`);
          } catch {
            clearInterval(heartbeat);
            sseClients.delete(res);
          }
        }, 15000);
        if (typeof heartbeat.unref === "function") heartbeat.unref();
        req.on("close", () => {
          clearInterval(heartbeat);
          sseClients.delete(res);
        });
        return;
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
      // Deal detail is party-scoped at the dispatcher because the handler
      // never receives identity (the generic GET tail passes undefined as
      // agent). Parties always read; the operator console reads via a valid
      // admin [SECURITY_DATA] token; any other keyed agent is a bystander.
      // Unknown ids 404 here with the handler's exact code so the contract
      // is unchanged whether the gate or the handler answers.
      if (method === "GET" && /^\/api\/deals\/[^/]+$/.test(pathname)) {
        const [, detailId] = match(method, pathname);
        const deal = store.getDeal(detailId);
        if (deal === null) {
          reject(404, error("NO_SUCH_DEAL", `no deal with id ${detailId}`));
          return;
        }
        const isAdmin = checkAdmin(req) === null;
        const viewer = isAdmin ? null : store.getAgentByKey(req.headers["x-agent-key"]);
        if (viewer === null && !isAdmin) {
          reject(401, error("UNAUTHORIZED", "reading deals and events requires a valid x-agent-key header"));
          return;
        }
        if (!isAdmin && viewer.id !== deal.buyer && viewer.id !== deal.seller) {
          reject(403, error("FORBIDDEN", `agent ${viewer.id} is not a party of deal ${detailId}`));
          return;
        }
        // The viewer rides through so the detail can name the caller's side
        // (yourRole) and who is waited on; admins read with a null viewer.
        const [detailStatus, detailPayload] = handlers["GET /api/deals/:id"](undefined, detailId, viewer);
        send(detailStatus, detailPayload);
        return;
      }
      // The events feed is agent-authenticated: a valid x-agent-key is
      // required. The operator console holds no agent key, so a valid admin
      // Bearer [REDACTED] accepted here too — either credential proves
      // you may read, and neither leaks into the other.
      if (method === "GET" && pathname === "/api/events") {
        const admin = checkAdmin(req);
        const viewer = admin === null ? { id: "admin" } : store.getAgentByKey(req.headers["x-agent-key"]);
        if (viewer === null) {
          reject(401, error("UNAUTHORIZED", "reading deals and events requires a valid x-agent-key header"));
          return;
        }
        const [evStatus, evPayload] = handlers["GET /api/events"](undefined, undefined, viewer);
        if (evPayload.ok === false) req.log.warn({ status: evStatus, code: evPayload.error?.code }, "request.rejected");
        send(evStatus, evPayload);
        return;
      }
      // Per-agent event stream: header-authenticated (EventSource cannot
      // set headers, so agents use fetch streaming). Only the agent's own
      // deal events plus registry/system events flow; Last-Event-ID (or
      // ?since=) replays missed frames from the bounded ring.
      if (method === "GET") {
        const agentStream = pathname.match(/^\/api\/agents\/([^/]+)\/events\/stream$/);
        if (agentStream !== null && decodeURIComponent(agentStream[1]) !== "") {
          const streamId = decodeURIComponent(agentStream[1]);
          const viewer = store.getAgentByKey(req.headers["x-agent-key"]);
          if (viewer === null) {
            reject(401, error("UNAUTHORIZED", "agent event streams require a valid x-agent-key header"));
            return;
          }
          if (viewer.id !== streamId) {
            reject(403, error("FORBIDDEN", `agent ${viewer.id} cannot read ${streamId}'s event stream`));
            return;
          }
          const live = agentStreams.get(streamId) ?? new Set();
          if (live.size >= MAX_AGENT_STREAMS) {
            reject(429, error("TOO_MANY_STREAMS", `agent ${streamId} already holds ${MAX_AGENT_STREAMS} streams`));
            return;
          }
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            // Proxies (nginx, Railway) must not buffer: each frame flushes.
            "X-Accel-Buffering": "no",
          });
          res.write(": connected\n\n");
          const parsed = new URL(req.url ?? "/", "http://localhost");
          const sinceRaw = req.headers["last-event-id"] ?? parsed.searchParams.get("since");
          const since = Number(sinceRaw);
          for (const e of events) {
            if (Number.isInteger(since) && e.seq <= since) continue;
            const deal = e.dealId === undefined || e.dealId === null ? null : store.getDeal(e.dealId);
            if (deal !== null && deal.buyer !== streamId && deal.seller !== streamId) continue;
            res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
          }
          const entry = { res };
          if (!agentStreams.has(streamId)) agentStreams.set(streamId, new Set());
          agentStreams.get(streamId).add(entry);
          const beat = setInterval(() => {
            try {
              res.write(": heartbeat\n\n");
            } catch {
              clearInterval(beat);
            }
          }, 15000);
          if (typeof beat.unref === "function") beat.unref();
          req.on("close", () => {
            clearInterval(beat);
            agentStreams.get(streamId)?.delete(entry);
            if (agentStreams.get(streamId)?.size === 0) agentStreams.delete(streamId);
          });
          return;
        }
      }
      // Owner-only self profile: the key resolves the caller, never a
      // URL id, so no agent can read another's row.
      if (method === "GET" && pathname === "/api/me") {
        const viewer = store.getAgentByKey(req.headers["x-agent-key"]);
        if (viewer === null) {
          reject(401, error("UNAUTHORIZED", "reading your own profile requires a valid x-agent-key header"));
          return;
        }
        const [meStatus, mePayload] = handlers["GET /api/me"](undefined, undefined, viewer);
        if (mePayload.ok === false) req.log.warn({ status: meStatus, code: mePayload.error?.code }, "request.rejected");
        send(meStatus, mePayload);
        return;
      }
      // Discovery document: base URL from PUBLIC_BASE_URL, falling back to
      // the request Host when unset (proxies should set the env var).
      if (method === "GET" && pathname === "/.well-known/agent.json") {
        const baseUrl = typeof process.env.PUBLIC_BASE_URL === "string" && process.env.PUBLIC_BASE_URL.length > 0
          ? process.env.PUBLIC_BASE_URL
          : `http://${req.headers.host ?? "localhost"}`;
        send(200, {
          ok: true,
          state: null,
          allowedMoves: [],
          result: buildAgentJson({ baseUrl, capabilities: ["image_gen", "video_gen", "data", "text_gen", "speech"], sandbox: isDemoSafe() }),
        });
        return;
      }
      const [handler, id] = match(method, pathname);
      if (handler === undefined) {
        // Static console assets are served here so API routes keep
        // priority: anything serveStatic rejects still gets the JSON 404.
        if (method === "GET") {
          const asset = serveStatic(pathname);
          if (asset !== null) {
            recordTraffic({ correlationId, method, path: pathname, status: 200, latencyMs: Date.now() - startedAt });
            const length = typeof asset.body === "string" ? Buffer.byteLength(asset.body) : asset.body.length;
            res.writeHead(200, { "content-type": asset.type, "content-length": length });
            res.end(asset.body);
            return;
          }
        }
        reject(404, error("NOT_FOUND", `no route for ${method} ${pathname}`));
        return;
      }
      // PATCH/DELETE admin routes carry no idempotency key by design
      // (single-operator console actions, not agent retries), so they
      // skip the POST idempotency gate but still get a parsed body.
      if (method === "POST" || method === "PATCH" || method === "DELETE") {
        const needsKey = method === "POST";
        // Agent authentication, before idempotency: only the registration
        // route mints credentials, so it is the one mutating route that
        // stays keyless. A replay never skips this gate. link-email resolves
        // the caller too — the handler then binds key to URL id.
        let agent = null;
        if (pathname.startsWith("/api/deals") || /^\/api\/agents\/[^/]+\/(link-email|rotate-key)$/.test(pathname)) {
          agent = store.getAgentByKey(req.headers["x-agent-key"]);
          if (agent === null) {
            reject(401, error("UNAUTHORIZED", "mutating protocol routes require a valid x-agent-key header"));
            return;
          }
        }
        let body;
        let bodyText;
        try {
          bodyText = await readBody(req, MAX_BODY_SIZE);
          body = bodyText.length === 0 ? {} : JSON.parse(bodyText);
        } catch (err) {
          if (err?.code === "PAYLOAD_TOO_LARGE") {
            reject(413, error("PAYLOAD_TOO_LARGE", "request body exceeds 1MB"));
            return;
          }
          reject(400, error("INVALID_JSON", "request body must be valid JSON"));
          return;
        }
        // The Idempotency-Key header is optional HTTP plumbing: when the
        // agent omits it, the protocol auto-generates a deterministic key
        // from agent + URL + body, so an identical retry within the short
        // auto window replays instead of re-executing. Explicit keys keep
        // the full TTL; auto keys expire after seconds so a deliberate
        // second action later still runs as a new request.
        const provided = req.headers["idempotency-key"];
        const auto = typeof provided !== "string" || provided.length === 0;
        // Idempotency is scoped per agent: the same key string from two
        // agents names two independent slots, so Agent B can never replay
        // Agent A's receipt. Keyless registration keeps the shared scope.
        const scope = agent !== null ? agent.id : "public";
        const idemKey = auto ? autoIdempotencyKey(scope, req.url, bodyText) : `${scope}:${provided}`;
        // Keyless PATCH/DELETE skip replay AND caching below: without a
        // client key every request would share one slot and a second
        // PATCH would replay the first one's response.
        const replay = needsKey ? idempotency.get(idemKey) : undefined;
        if (replay !== undefined) {
          send(replay.status, replay.payload, replay.headers);
          return;
        }
        // Awaited so async handlers (profile, link-email) work; sync
        // handlers return plain tuples, which await passes through. req
        // rides fourth so registration can rate-limit by client IP.
        const [status, payload, headers] = await handler(body, id, agent, req);
        // Cache successes only: caching a rejection would freeze the first
        // error in place and punish clients that retry with a fixed request.
        // Headers ride along so a replayed pay still carries its receipt.
        // `at` feeds the TTL reaper: explicit entries die after 24 hours,
        // auto entries after the short auto window.
        if (needsKey && payload.ok === true) idempotency.set(idemKey, { status, payload, headers, at: Date.now(), auto });
        if (payload.ok === false) req.log.warn({ status, code: payload.error?.code }, "request.rejected");
        send(status, payload, headers);
        return;
      }
      const [status, payload] = await handler(undefined, id, undefined, query);
      if (payload.ok === false) req.log.warn({ status, code: payload.error?.code }, "request.rejected");
      send(status, payload);
    } catch (err) {
      // The real error goes to the logs only; the wire gets a generic
      // envelope so SQLite internals never leak to callers.
      req.log.error({ err }, "request.crashed");
      send(500, error("INTERNAL_ERROR", "An unexpected error occurred."));
    }
  });

  return { server, store, ledger, sessions, stopIdemSweep: () => clearInterval(idemSweep), closeAllStreams };
}

export function startServer({ dbPath, port = 0, host = "127.0.0.1" } = {}) {
  const { server, store, sessions, stopIdemSweep, closeAllStreams } = createApp(dbPath);
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actual = typeof address === "object" && address !== null ? address.port : port;
      resolve({
        url: `http://${host}:${actual}`,
        port: actual,
        close: () =>
          new Promise((done) => {
            // End SSE feeds first: server.close() waits for open
            // connections, and an SSE socket never ends on its own.
            try {
              closeAllStreams();
            } catch {
              // Best effort: shutdown must proceed regardless.
            }
            if (typeof server.closeAllConnections === "function") server.closeAllConnections();
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
