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

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazaar-deals-"));
  const started = await startServer({ dbPath: path.join(dir, "store.db"), port: 0 });
  url = started.url;
  stop = started.close;
  buyerKey = (await post("/api/agents", { id: "list-buyer", role: "buyer" }))[1].result.api_key;
  sellerKey = (await post("/api/agents", { id: "list-seller", role: "seller" }))[1].result.api_key;
  rivalKey = (await post("/api/agents", { id: "list-rival", role: "buyer" }))[1].result.api_key;
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

test("protocol: deal metadata round-trips from open to read-back", async () => {
  // Fresh parties: the listing tests below assert exact scoped deal sets,
  // so this round-trip must not add deals to list-buyer/list-seller.
  const metaBuyer = (await post("/api/agents", { id: "meta-buyer", role: "buyer" }))[1].result.api_key;
  await post("/api/agents", { id: "meta-seller", role: "seller" });
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

test("protocol: seller ACCEPT at the standing offer price reaches AGREED", async () => {
  // Regression for the simulation bug: OFFER 60 followed by ACCEPT 60 used
  // to die with DUPLICATE_OFFER. Accepting the standing price is the
  // normal happy path.
  // Fresh parties: the listing tests below assert exact scoped deal
  // sets, so this regression must not add deals to list-buyer/list-seller.
  const spBuyer = (await post("/api/agents", { id: "sp-buyer", role: "buyer" }))[1].result.api_key;
  const spSeller = (await post("/api/agents", { id: "sp-seller", role: "seller" }))[1].result.api_key;
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
  process.env.ADMIN_SECRET = "test-dir-secret";
  const register = async (id, role) => {
    const [s, b] = await post("/api/agents", { id, role });
    assert.equal(s, 200);
    return b.result.api_key;
  };
  await register("dir-buyer", "buyer");
  await register("dir-seller", "seller");
  const approve = (id) =>
    fetch(url + `/api/admin/agents/${id}/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-dir-secret",
        "idempotency-key": freshKey(),
      },
      body: JSON.stringify({}),
    }).then(async (r) => r.status);
  assert.equal(await approve("dir-buyer"), 200);
  assert.equal(await approve("dir-seller"), 200);
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
