import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../../protocol/server.js";

// The sandbox sets HTTP(S)_PROXY for external traffic; loopback test
// traffic must bypass it or fetch tunnels 127.0.0.1 through the proxy.
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";
process.env.ADMIN_SECRET = "test-deals-secret";

let url;
let stop;
let dir;
let n = 0;

const freshKey = () => `deals-${(n += 1)}`;

async function post(p, body, agentKey) {
  const headers = { "content-type": "application/json", "idempotency-key": freshKey() };
  if (agentKey !== undefined) headers["x-agent-key"] = agentKey;
  const res = await fetch(url + p, { method: "POST", headers, body: JSON.stringify(body) });
  return [res.status, await res.json()];
}

async function get(p, agentKey) {
  const headers = agentKey === undefined ? {} : { "x-agent-key": agentKey };
  const res = await fetch(url + p, { headers });
  return [res.status, await res.json()];
}

let buyerKey;
let sellerKey;
let rivalKey;

// Operator helpers: approve (ACTIVE, no probation) or suspend a listing so
// commerce tests run as approved agents. PENDING is the default for every
// fresh registration, which is exactly what the ACTIVE-gate test needs.
async function moderate(id, verb, body = {}) {
  const res = await fetch(url + `/api/admin/agents/${id}/${verb}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.ADMIN_SECRET}`,
      "idempotency-key": freshKey(),
    },
    body: JSON.stringify(body),
  });
  return res.status;
}

async function approve(id) {
  const status = await moderate(id, "approve");
  assert.equal(status, 200, `approve ${id}`);
}

async function suspend(id) {
  const status = await moderate(id, "suspend", { reason: "test suspension" });
  assert.equal(status, 200, `suspend ${id}`);
}

async function patchAgent(id, body) {
  const res = await fetch(url + `/api/admin/agents/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "idempotency-key": freshKey(), authorization: `Bearer ${process.env.ADMIN_SECRET}` },
    body: JSON.stringify(body),
  });
  return [res.status, await res.json()];
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazaar-deals-"));
  const started = await startServer({ dbPath: path.join(dir, "store.db"), port: 0 });
  url = started.url;
  stop = started.close;
  buyerKey = (await post("/api/agents", { id: "list-buyer", role: "buyer" }))[1].result.api_key;
  sellerKey = (await post("/api/agents", { id: "list-seller", role: "seller" }))[1].result.api_key;
  rivalKey = (await post("/api/agents", { id: "list-rival", role: "buyer" }))[1].result.api_key;
  // Commerce requires ACTIVE counterparties: approve the seed agents so the
  // pre-existing deal flows below keep trading after the ACTIVE gate.
  await approve("list-buyer");
  await approve("list-seller");
  await approve("list-rival");
  // Three buyer deals across three states, plus one rival deal that must
  // stay invisible to the buyer.
  await post("/api/deals", { id: "pg-neg", buyer: "list-buyer", seller: "list-seller", price: 60 }, buyerKey);
  await post("/api/deals", { id: "pg-agree", buyer: "list-buyer", seller: "list-seller", price: 60 }, buyerKey);
  await post("/api/deals/pg-agree/moves", { key: "k1", kind: "OFFER", price: 60 }, buyerKey);
  await post("/api/deals/pg-agree/moves", { key: "k2", kind: "ACCEPT", price: 50 }, sellerKey);
  await post("/api/deals", { id: "pg-lock", buyer: "list-buyer", seller: "list-seller", price: 60 }, buyerKey);
  await post("/api/deals/pg-lock/moves", { key: "k1", kind: "OFFER", price: 60 }, buyerKey);
  await post("/api/deals/pg-lock/moves", { key: "k2", kind: "ACCEPT", price: 50 }, sellerKey);
  await post("/api/deals/pg-lock/pay", {}, buyerKey);
  await post("/api/deals", { id: "pg-rival", buyer: "list-rival", seller: "list-seller", price: 10 }, rivalKey);
});

after(async () => {
  await stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("protocol: only ACTIVE agents can open deals", async () => {
  const actBuyer = (await post("/api/agents", { id: "act-buyer", role: "buyer" }))[1].result.api_key;
  await post("/api/agents", { id: "act-seller", role: "seller" });
  await approve("act-buyer");
  await approve("act-seller");
  const suspKey = (await post("/api/agents", { id: "susp-seller", role: "seller" }))[1].result.api_key;
  await approve("susp-seller");
  await suspend("susp-seller");
  const pendKey = (await post("/api/agents", { id: "pend-buyer", role: "buyer" }))[1].result.api_key;

  // Suspended counterparty: an active buyer cannot hire them.
  const [s1, b1] = await post(
    "/api/deals",
    { id: "pg-susp-counterparty", buyer: "act-buyer", seller: "susp-seller", price: 10 },
    actBuyer,
  );
  assert.equal(s1, 403);
  assert.equal(b1.error.code, "FORBIDDEN");
  // The suspended agent cannot open deals themselves either.
  const [s2, b2] = await post(
    "/api/deals",
    { id: "pg-susp-opener", buyer: "act-buyer", seller: "susp-seller", price: 10 },
    suspKey,
  );
  assert.equal(s2, 403);
  assert.equal(b2.error.code, "FORBIDDEN");
  // PENDING agents cannot trade until approved.
  const [s3, b3] = await post(
    "/api/deals",
    { id: "pg-pend", buyer: "pend-buyer", seller: "act-seller", price: 10 },
    pendKey,
  );
  assert.equal(s3, 403);
  assert.equal(b3.error.code, "FORBIDDEN");
  // Control: two ACTIVE agents still trade (act-buyer is not one of the
  // listing-test parties, so this deal pollutes no exact-set assertion).
  const [s4] = await post(
    "/api/deals",
    { id: "pg-active-ok", buyer: "act-buyer", seller: "act-seller", price: 10 },
    actBuyer,
  );
  assert.equal(s4, 200);
});

test("protocol: deal metadata round-trips from open to read-back", async () => {
  // Fresh parties: the listing tests below assert exact scoped deal sets,
  // so this round-trip must not add deals to list-buyer/list-seller.
  const metaBuyer = (await post("/api/agents", { id: "meta-buyer", role: "buyer" }))[1].result.api_key;
  await post("/api/agents", { id: "meta-seller", role: "seller" });
  await approve("meta-buyer");
  await approve("meta-seller");
  const [os, ob] = await post(
    "/api/deals",
    { id: "pg-meta", buyer: "meta-buyer", seller: "meta-seller", price: 60, metadata: { prompt: "hello" } },
    metaBuyer,
  );
  assert.equal(os, 200);
  assert.deepEqual(ob.result.deal.metadata, { prompt: "hello" });
  const [gs, gb] = await get("/api/deals/pg-meta", metaBuyer);
  assert.equal(gs, 200);
  assert.deepEqual(gb.result.deal.metadata, { prompt: "hello" });
});

test("protocol: failed lock on ACCEPT leaves deal in NEGOTIATING, not AGREED", async () => {
  // Fresh parties: the listing tests below assert exact scoped deal sets.
  const poorBuyer = (await post("/api/agents", { id: "nolock-buyer", role: "buyer" }))[1].result.api_key;
  const poorSeller = (await post("/api/agents", { id: "nolock-seller", role: "seller" }))[1].result.api_key;
  await approve("nolock-buyer");
  await approve("nolock-seller");
  const [os] = await post(
    "/api/deals",
    { id: "pg-nolock", buyer: "nolock-buyer", seller: "nolock-seller", price: 50 },
    poorBuyer,
  );
  assert.equal(os, 200);
  // The seller accepts above the buyer's funded balance: the referee floor
  // passes (open floor), but the ledger lock must fail.
  const [as, ab] = await post("/api/deals/pg-nolock/moves", { key: "k-acc", kind: "ACCEPT", price: 80 }, poorSeller);
  assert.equal(as, 400);
  assert.equal(ab.ok, false);
  assert.equal(ab.error.code, "INSUFFICIENT_FUNDS");
  // Nothing persisted: still negotiating, no phantom ACCEPT move recorded.
  const [gs, gb] = await get("/api/deals/pg-nolock", poorBuyer);
  assert.equal(gs, 200);
  assert.equal(gb.state, "NEGOTIATING");
  assert.deepEqual(gb.result.moves, []);
});

test("protocol: mid-deal listing edits do not change referee rules", async () => {
  // Fresh parties: the listing tests below assert exact scoped deal sets.
  const snapBuyer = (await post("/api/agents", { id: "snap-buyer", role: "buyer" }))[1].result.api_key;
  const snapSeller = (await post("/api/agents", { id: "snap-seller", role: "seller", service_type: "negotiation", min_price: 50 }))[1].result.api_key;
  await approve("snap-buyer");
  await approve("snap-seller");
  const [os] = await post(
    "/api/deals",
    { id: "pg-snap", buyer: "snap-buyer", seller: "snap-seller", price: 100 },
    snapBuyer,
  );
  assert.equal(os, 200);
  // Operator quadruples the floor mid-deal; the running deal must not care.
  const [ps] = await patchAgent("snap-seller", { min_price: 200 });
  assert.equal(ps, 200);
  const [s1] = await post("/api/deals/pg-snap/moves", { key: "k1", kind: "OFFER", price: 100 }, snapBuyer);
  assert.equal(s1, 200);
  // 100 clears the open-time floor of 50. Pre-snapshot this 400s with
  // UNDER_FLOOR against the live floor of 200.
  const [s2, b2] = await post("/api/deals/pg-snap/moves", { key: "k2", kind: "ACCEPT", price: 100 }, snapSeller);
  assert.equal(s2, 200);
  assert.equal(b2.state, "AGREED");
});

test("protocol: seller ACCEPT at the standing offer price reaches AGREED", async () => {
  // Regression for the simulation bug: OFFER 60 followed by ACCEPT 60 used
  // to die with DUPLICATE_OFFER. Accepting the standing price is the
  // normal happy path.
  // Fresh parties: the listing tests below assert exact scoped deal
  // sets, so this regression must not add deals to list-buyer/list-seller.
  const spBuyer = (await post("/api/agents", { id: "sp-buyer", role: "buyer" }))[1].result.api_key;
  const spSeller = (await post("/api/agents", { id: "sp-seller", role: "seller" }))[1].result.api_key;
  await approve("sp-buyer");
  await approve("sp-seller");
  const [os_, ob] = await post("/api/deals", { id: "pg-sameprice", buyer: "sp-buyer", seller: "sp-seller", price: 60 }, spBuyer);
  assert.equal(os_, 200);
  assert.equal(ob.state, "NEGOTIATING");
  const [s1, b1] = await post("/api/deals/pg-sameprice/moves", { key: "k1", kind: "OFFER", price: 60 }, spBuyer);
  assert.equal(s1, 200);
  assert.equal(b1.state, "NEGOTIATING");
  const [s2, b2] = await post("/api/deals/pg-sameprice/moves", { key: "k2", kind: "ACCEPT", price: 60 }, spSeller);
  assert.equal(s2, 200);
  assert.equal(b2.state, "AGREED");
});

test("protocol: health answers without auth", async () => {
  const [status, body] = await get("/health");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.result, { status: "UP" });
});

test("protocol: the public directory lists approved sellers, never buyers", async () => {
  const register = async (id, role) => {
    const [s, b] = await post("/api/agents", { id, role });
    assert.equal(s, 200);
    return b.result.api_key;
  };
  await register("dir-buyer", "buyer");
  await register("dir-seller", "seller");
  await approve("dir-buyer");
  await approve("dir-seller");
  const [, listed] = await get("/api/agents");
  const ids = listed.result.agents.map((a) => a.id);
  assert.ok(ids.includes("dir-seller"));
  assert.ok(!ids.includes("dir-buyer"));
});

test("protocol: deal listing requires a key and stays scoped to your deals", async () => {
  const [unauth, unauthBody] = await get("/api/deals");
  assert.equal(unauth, 401);
  assert.equal(unauthBody.error.code, "UNAUTHORIZED");
  const [status, body] = await get("/api/deals", buyerKey);
  assert.equal(status, 200);
  assert.deepEqual(
    body.result.deals.map((d) => d.id),
    ["pg-neg", "pg-agree", "pg-lock"],
  );
  assert.equal(body.result.total, 3);
  const [rivalStatus, rivalBody] = await get("/api/deals", rivalKey);
  assert.equal(rivalStatus, 200);
  assert.deepEqual(
    rivalBody.result.deals.map((d) => d.id),
    ["pg-rival"],
  );
  // The seller is a party too — including on the rival's deal, where they
  // are the named seller. Party scoping is by participation, not by who
  // opened.
  const [sellerStatus, sellerBody] = await get("/api/deals", sellerKey);
  assert.equal(sellerStatus, 200);
  assert.equal(sellerBody.result.total, 4);
});

test("protocol: deal listing pages and filters by status", async () => {
  const [, first] = await get("/api/deals?limit=2", buyerKey);
  assert.deepEqual(
    first.result.deals.map((d) => d.id),
    ["pg-neg", "pg-agree"],
  );
  assert.equal(first.result.total, 3);
  const [, second] = await get("/api/deals?limit=2&offset=2", buyerKey);
  assert.deepEqual(
    second.result.deals.map((d) => d.id),
    ["pg-lock"],
  );
  const [, filtered] = await get("/api/deals?status=ESCROW_LOCKED", buyerKey);
  assert.deepEqual(
    filtered.result.deals.map((d) => d.id),
    ["pg-lock"],
  );
  assert.equal(filtered.result.total, 1);
});

test("protocol: deal listing rejects bad filters", async () => {
  for (const query of ["?status=BOGUS", "?limit=0", "?limit=101", "?limit=abc", "?offset=-1"]) {
    const [status, body] = await get(`/api/deals${query}`, buyerKey);
    assert.equal(status, 400, query);
    assert.equal(body.error.code, "INVALID_SCHEMA", query);
  }
});

test("protocol: negotiation sellers accept below list but above min_price; endpoints cannot", async () => {
  const negSeller = (await post("/api/agents", { id: "neg-seller", role: "seller", price: 200, min_price: 50, service_type: "negotiation" }))[1].result.api_key;
  const epSeller = (await post("/api/agents", { id: "ep-seller", role: "seller", price: 100, service_type: "endpoint" }))[1].result.api_key;
  await approve("neg-seller");
  await approve("ep-seller");
  // Negotiation: accept 80 on a 150 deal — below the 200 list, above the 50 floor.
  assert.equal((await post("/api/deals", { id: "d-neg-fl", buyer: "list-buyer", seller: "neg-seller", price: 150 }, buyerKey))[0], 200);
  assert.equal((await post("/api/deals/d-neg-fl/moves", { key: "k1", kind: "OFFER", price: 150 }, buyerKey))[0], 200);
  const [as, ab] = await post("/api/deals/d-neg-fl/moves", { key: "k2", kind: "ACCEPT", price: 80 }, negSeller);
  assert.equal(as, 200);
  assert.equal(ab.state, "AGREED");
  // Same seller rejects below the floor, and the bounds name it.
  assert.equal((await post("/api/deals", { id: "d-neg-lo", buyer: "list-buyer", seller: "neg-seller", price: 150 }, buyerKey))[0], 200);
  assert.equal((await post("/api/deals/d-neg-lo/moves", { key: "k1", kind: "OFFER", price: 150 }, buyerKey))[0], 200);
  const [ls, lb] = await post("/api/deals/d-neg-lo/moves", { key: "k2", kind: "ACCEPT", price: 40 }, negSeller);
  assert.equal(ls, 400);
  assert.equal(lb.error.code, "UNDER_FLOOR");
  assert.deepEqual(lb.bounds, { your_offer: 40, floor: 50, last_offer: 150 });
  // Endpoint: the list price is the floor — 80 on a 100 listing is rejected.
  assert.equal((await post("/api/deals", { id: "d-ep-lo", buyer: "list-buyer", seller: "ep-seller", price: 150 }, buyerKey))[0], 200);
  assert.equal((await post("/api/deals/d-ep-lo/moves", { key: "k1", kind: "OFFER", price: 150 }, buyerKey))[0], 200);
  const [es, eb] = await post("/api/deals/d-ep-lo/moves", { key: "k2", kind: "ACCEPT", price: 80 }, epSeller);
  assert.equal(es, 400);
  assert.equal(eb.error.code, "UNDER_FLOOR");
  assert.equal(eb.bounds.floor, 100);
  const [fs, fb] = await post("/api/deals/d-ep-lo/moves", { key: "k3", kind: "ACCEPT", price: 100 }, epSeller);
  assert.equal(fs, 200);
  assert.equal(fb.state, "AGREED");
});
