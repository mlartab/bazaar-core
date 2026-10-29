import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, pruneIdempotency } from "../../protocol/server.js";
import { EVENT_CAP, IDEMPOTENCY_TTL_MS } from "../../protocol/config.js";

// The sandbox sets HTTP(S)_PROXY for external traffic; loopback test
// traffic must bypass it or fetch tunnels 127.0.0.1 through the proxy.
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";
// Same-process server reads this at request time; the secret never leaves
// the test process.
process.env.ADMIN_SECRET = "test-auth-secret";

let url;
let stop;
let dir;
let n = 0;

const freshKey = () => `auth-${(n += 1)}`;

async function post(p, body, { key, agentKey } = {}) {
  const headers = { "content-type": "application/json", "idempotency-key": key ?? freshKey() };
  if (agentKey !== undefined) headers["x-agent-key"] = agentKey;
  const res = await fetch(url + p, { method: "POST", headers, body: JSON.stringify(body) });
  return [res.status, await res.json()];
}

// No default key here: callers pass buyerKey/sellerKey explicitly, and
// keyless calls (public status endpoint, negative auth tests) pass nothing.
async function get(p, agentKey) {
  const headers = agentKey === undefined ? {} : { "x-agent-key": agentKey };
  const res = await fetch(url + p, { headers });
  return [res.status, await res.json()];
}

function assertErr(body, code) {
  assert.equal(body.ok, false);
  assert.equal(body.error.code, code);
}

let buyerKey;
let sellerKey;
let rivalKey;

async function register(id, role) {
  const [status, body] = await post("/api/agents", { id, role });
  assert.equal(status, 200);
  assert.ok(typeof body.result.api_key === "string" && body.result.api_key.length > 0);
  return body.result.api_key;
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazaar-auth-"));
  const started = await startServer({ dbPath: path.join(dir, "store.db"), port: 0 });
  url = started.url;
  stop = started.close;
  buyerKey = await register("auth-buyer", "buyer");
  sellerKey = await register("auth-seller", "seller");
  rivalKey = await register("auth-rival", "buyer");
});

after(async () => {
  await stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("protocol: registration issues a key the public shapes never leak", async () => {
  const [rs, rb] = await post("/api/agents", { id: "auth-quiet", role: "seller" });
  assert.equal(rs, 200);
  const key = rb.result.api_key;
  assert.ok(typeof key === "string" && key.length > 0);
  // The credential rides beside the frozen agent shape, never inside it,
  // and the public status endpoint cannot return it either.
  assert.ok(!("api_key" in rb.result.agent));
  assert.notEqual(key, buyerKey);
  const [status, body] = await get("/api/agents/auth-quiet/status");
  assert.equal(status, 200);
  assert.ok(!("api_key" in body));
});

test("protocol: approval hands the key to the operator", async () => {
  const res = await fetch(url + "/api/admin/agents/auth-buyer/approve", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-auth-secret",
      "idempotency-key": freshKey(),
    },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.result.api_key, buyerKey);
});

test("protocol: mutating routes without a key are rejected", async () => {
  const [os_, ob] = await post("/api/deals", { id: "auth-nodeal", buyer: "auth-buyer", seller: "auth-seller", price: 10 });
  assert.equal(os_, 401);
  assertErr(ob, "UNAUTHORIZED");
  const [ms, mb] = await post("/api/deals/nope/moves", { key: "k", kind: "WALK" });
  assert.equal(ms, 401);
  assertErr(mb, "UNAUTHORIZED");
  const [ps, pb] = await post("/api/deals/nope/pay", {}, { agentKey: "not-a-real-key" });
  assert.equal(ps, 401);
  assertErr(pb, "UNAUTHORIZED");
});

test("protocol: a non-party cannot open, move, or pay", async () => {
  const [os_, ob] = await post(
    "/api/deals",
    { id: "auth-rival-open", buyer: "auth-buyer", seller: "auth-seller", price: 10 },
    { agentKey: rivalKey },
  );
  assert.equal(os_, 403);
  assertErr(ob, "FORBIDDEN");
  const [ds, db] = await post(
    "/api/deals",
    { id: "auth-d1", buyer: "auth-buyer", seller: "auth-seller", price: 50 },
    { agentKey: buyerKey },
  );
  assert.equal(ds, 200);
  assert.equal(db.state, "NEGOTIATING");
  const [ms, mb] = await post("/api/deals/auth-d1/moves", { key: "k1", kind: "WALK" }, { agentKey: rivalKey });
  assert.equal(ms, 403);
  assertErr(mb, "FORBIDDEN");
  const [ps, pb] = await post("/api/deals/auth-d1/pay", {}, { agentKey: rivalKey });
  assert.equal(ps, 403);
  assertErr(pb, "FORBIDDEN");
});

test("protocol: delivery on a negotiating deal is rejected", async () => {
  const [os] = await post(
    "/api/deals",
    { id: "auth-d0", buyer: "auth-buyer", seller: "auth-seller", price: 25 },
    { agentKey: buyerKey },
  );
  assert.equal(os, 200);
  const [ds, db] = await post(
    "/api/deals/auth-d0/delivery",
    { id: "auth-del-0", dealId: "auth-d0", deliveryUrl: "deliverable:auth-d0" },
    { agentKey: sellerKey },
  );
  assert.equal(ds, 409);
  assertErr(db, "MUST_PAY_BEFORE_DELIVERY");
  // The rejected call moved nothing: the deal is still negotiating.
  const [gs, gb] = await get("/api/deals/auth-d0", buyerKey);
  assert.equal(gs, 200);
  assert.equal(gb.state, "NEGOTIATING");
});

test("protocol: delivery is seller-only", async () => {
  const [ds] = await post(
    "/api/deals",
    { id: "auth-d2", buyer: "auth-buyer", seller: "auth-seller", price: 60 },
    { agentKey: buyerKey },
  );
  assert.equal(ds, 200);
  const [o1] = await post("/api/deals/auth-d2/moves", { key: "k1", kind: "OFFER", price: 60 }, { agentKey: buyerKey });
  assert.equal(o1, 200);
  const [a1] = await post("/api/deals/auth-d2/moves", { key: "k2", kind: "ACCEPT", price: 50 }, { agentKey: sellerKey });
  assert.equal(a1, 200);
  const [p1, p1b] = await post("/api/deals/auth-d2/pay", {}, { agentKey: buyerKey });
  assert.equal(p1, 200);
  assert.equal(p1b.state, "ESCROW_LOCKED");
  const [bs, bb] = await post(
    "/api/deals/auth-d2/delivery",
    { id: "auth-del-b", dealId: "auth-d2", deliveryUrl: "deliverable:auth-d2" },
    { agentKey: buyerKey },
  );
  assert.equal(bs, 403);
  assertErr(bb, "FORBIDDEN");
  const [ss, sb] = await post(
    "/api/deals/auth-d2/delivery",
    { id: "auth-del-s", dealId: "auth-d2", deliveryUrl: "deliverable:auth-d2" },
    { agentKey: sellerKey },
  );
  assert.equal(ss, 202);
  assert.equal(sb.state, "VERIFYING");
});

test("protocol: delivery on an AGREED deal is rejected before pay", async () => {
  const [ds] = await post(
    "/api/deals",
    { id: "auth-d3", buyer: "auth-buyer", seller: "auth-seller", price: 60 },
    { agentKey: buyerKey },
  );
  assert.equal(ds, 200);
  const [o1] = await post("/api/deals/auth-d3/moves", { key: "k1", kind: "OFFER", price: 60 }, { agentKey: buyerKey });
  assert.equal(o1, 200);
  const [a1] = await post("/api/deals/auth-d3/moves", { key: "k2", kind: "ACCEPT", price: 50 }, { agentKey: sellerKey });
  assert.equal(a1, 200);
  // No pay: the walk-in capture is gone, so the seller is turned away.
  const [ss, sb] = await post(
    "/api/deals/auth-d3/delivery",
    { id: "auth-del-agreed", dealId: "auth-d3", deliveryUrl: "deliverable:auth-d3" },
    { agentKey: sellerKey },
  );
  assert.equal(ss, 409);
  assertErr(sb, "MUST_PAY_BEFORE_DELIVERY");
  const [gs, gb] = await get("/api/deals/auth-d3", buyerKey);
  assert.equal(gs, 200);
  assert.equal(gb.state, "AGREED");
});

test("protocol: deal detail and events require an agent key", async () => {
  const [ds, db] = await get("/api/deals/auth-d0");
  assert.equal(ds, 401);
  assertErr(db, "UNAUTHORIZED");
  const [es, eb] = await get("/api/events");
  assert.equal(es, 401);
  assertErr(eb, "UNAUTHORIZED");
  // A wrong key is still rejected, not treated as anonymous.
  const [ws] = await get("/api/deals/auth-d0", "not-a-real-key");
  assert.equal(ws, 401);
});

test("protocol: idempotency keys are scoped per agent", async () => {
  // Same key string, two agents, same-shaped registration-shaped deal open:
  // open a deal as the buyer with a fixed key, then prove the rival cannot
  // replay it — their slot is independent and their non-party open is 403,
  // not a replayed 200.
  const shared = "shared-idem-key";
  const [bs, bb] = await post(
    "/api/deals",
    { id: "auth-scoped", buyer: "auth-buyer", seller: "auth-seller", price: 10 },
    { key: shared, agentKey: buyerKey },
  );
  assert.equal(bs, 200);
  assert.equal(bb.state, "NEGOTIATING");
  const [rs, rb] = await post(
    "/api/deals",
    { id: "auth-scoped-rival", buyer: "auth-rival", seller: "auth-seller", price: 10 },
    { key: shared, agentKey: rivalKey },
  );
  assert.equal(rs, 200);
  assert.equal(rb.result.deal.id, "auth-scoped-rival");
  // And the buyer's own replay still works: same agent, same key.
  const [ps, pb] = await post(
    "/api/deals",
    { id: "auth-scoped", buyer: "auth-buyer", seller: "auth-seller", price: 10 },
    { key: shared, agentKey: buyerKey },
  );
  assert.equal(ps, 200);
  assert.deepEqual(pb, bb);
});

test("protocol: oversized bodies are rejected before parsing", async () => {
  const big = await post(
    "/api/deals/auth-d2/moves",
    { key: "k-big", kind: "WALK", pad: "x".repeat(2 * 1024 * 1024) },
    { agentKey: buyerKey },
  );
  assert.equal(big[0], 413);
  assertErr(big[1], "PAYLOAD_TOO_LARGE");
});

test("protocol: duplicate delivery ids return a 409 contract error, never internals", async () => {
  const setup = async (id) => {
    const [ds] = await post("/api/deals", { id, buyer: "auth-buyer", seller: "auth-seller", price: 40 }, { agentKey: buyerKey });
    assert.equal(ds, 200);
    const [o1] = await post(`/api/deals/${id}/moves`, { key: "k1", kind: "OFFER", price: 40 }, { agentKey: buyerKey });
    assert.equal(o1, 200);
    const [a1] = await post(`/api/deals/${id}/moves`, { key: "k2", kind: "ACCEPT", price: 30 }, { agentKey: sellerKey });
    assert.equal(a1, 200);
    const [p1] = await post(`/api/deals/${id}/pay`, {}, { agentKey: buyerKey });
    assert.equal(p1, 200);
  };
  await setup("auth-dup1");
  await setup("auth-dup2");
  const [first] = await post(
    "/api/deals/auth-dup1/delivery",
    { id: "auth-del-dup", dealId: "auth-dup1", deliveryUrl: "deliverable:dup" },
    { agentKey: sellerKey },
  );
  assert.equal(first, 202);
  // Same id on the second live escrow: a contract error, not a crash.
  const [second, body] = await post(
    "/api/deals/auth-dup2/delivery",
    { id: "auth-del-dup", dealId: "auth-dup2", deliveryUrl: "deliverable:dup" },
    { agentKey: sellerKey },
  );
  assert.equal(second, 409);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "DUPLICATE_DELIVERY");
  assert.equal(typeof body.error.message, "string");
});

test("protocol: pruneIdempotency drops only entries past the TTL", () => {
  const now = 10_000_000;
  const map = new Map([
    ["old", { status: 200, payload: {}, at: now - IDEMPOTENCY_TTL_MS - 1 }],
    ["edge", { status: 200, payload: {}, at: now - IDEMPOTENCY_TTL_MS }],
    ["fresh", { status: 200, payload: {}, at: now - 1 }],
  ]);
  pruneIdempotency(map, now, IDEMPOTENCY_TTL_MS);
  assert.deepEqual([...map.keys()], ["edge", "fresh"]);
});

test("protocol: the events feed is capped at the newest 500 rows", async () => {
  // 510 fresh registrations: every one emits, so the feed must drop the
  // oldest 10 plus whatever earlier tests in this file emitted.
  for (let i = 0; i < 510; i += 1) {
    const [status] = await post("/api/agents", { id: `auth-flood-${i}`, role: "buyer" });
    assert.equal(status, 200);
  }
  const [, body] = await get("/api/events", buyerKey);
  const events = body.result.events;
  assert.equal(events.length, EVENT_CAP);
  for (let i = 1; i < events.length; i += 1) {
    assert.equal(events[i].seq, events[i - 1].seq + 1);
  }
}, { timeout: 120000 });
