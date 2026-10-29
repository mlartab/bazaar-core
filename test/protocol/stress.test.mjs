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
// Same-process server reads this at request time; the secret never leaves
// the test process.
process.env.ADMIN_SECRET = "test-stress-secret";

let url;
let stop;
let dir;
let n = 0;

const freshKey = () => `stress-${(n += 1)}`;

async function post(p, body, k = freshKey(), agentKey) {
  const headers = { "content-type": "application/json", "idempotency-key": k };
  if (agentKey !== undefined) headers["x-agent-key"] = agentKey;
  const res = await fetch(url + p, { method: "POST", headers, body: JSON.stringify(body) });
  return [res.status, await res.json()];
}

async function get(p, agentKey, admin = false) {
  const headers = {};
  if (agentKey !== undefined) headers["x-agent-key"] = agentKey;
  if (admin) headers.authorization = "Bearer test-stress-secret";
  const res = await fetch(url + p, { headers });
  return [res.status, await res.json()];
}

let buyerKey;
let sellerKey;
let spyKey;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazaar-stress-"));
  const started = await startServer({ dbPath: path.join(dir, "store.db"), port: 0 });
  url = started.url;
  stop = started.close;
  buyerKey = (await post("/api/agents", { id: "s-buyer", role: "buyer" }))[1].result.api_key;
  sellerKey = (await post("/api/agents", { id: "s-seller", role: "seller" }))[1].result.api_key;
  spyKey = (await post("/api/agents", { id: "s-spy", role: "buyer" }))[1].result.api_key;
});

after(async () => {
  await stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function waitForState(id, states, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const [status, body] = await get(`/api/deals/${id}`, buyerKey);
    assert.equal(status, 200);
    if (states.includes(body.state)) return body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`deal ${id} never reached ${states.join("/")}`);
}

// Drive a deal to AGREED: open, OFFER, ACCEPT at the standing price.
async function toAgreed(id, price = 50) {
  const [os] = await post("/api/deals", { id, buyer: "s-buyer", seller: "s-seller", price }, freshKey(), buyerKey);
  assert.equal(os, 200);
  assert.equal((await post(`/api/deals/${id}/moves`, { key: "k1", kind: "OFFER", price }, freshKey(), buyerKey))[0], 200);
  const [as] = await post(`/api/deals/${id}/moves`, { key: "k2", kind: "ACCEPT", price }, freshKey(), sellerKey);
  assert.equal(as, 200);
}

test("stress: ten simultaneous opens of one deal id leave exactly one winner", async () => {
  // Distinct keys force every request through the real handler: sharing one
  // key would replay the first 200 and fake the race.
  const attempts = await Promise.all(
    Array.from({ length: 10 }, () =>
      post("/api/deals", { id: "race-open", buyer: "s-buyer", seller: "s-seller", price: 10 }, freshKey(), buyerKey),
    ),
  );
  const won = attempts.filter(([s]) => s === 200);
  const lost = attempts.filter(([s, b]) => s === 409 && b.error.code === "DUPLICATE_DEAL");
  assert.equal(won.length, 1);
  assert.equal(lost.length, 9);
  const [gs, gb] = await get("/api/deals/race-open", buyerKey);
  assert.equal(gs, 200);
  assert.equal(gb.state, "NEGOTIATING");
});

test("stress: ten simultaneous pays allow a single capture", async () => {
  await toAgreed("race-pay", 60);
  const attempts = await Promise.all(
    Array.from({ length: 10 }, () => post("/api/deals/race-pay/pay", {}, freshKey(), buyerKey)),
  );
  const won = attempts.filter(([s]) => s === 200);
  const lost = attempts.filter(([s, b]) => s === 409 && b.error.code === "ALREADY_LOCKED");
  assert.equal(won.length, 1);
  assert.equal(lost.length, 9);
  assert.ok(typeof won[0][1].result.receipt === "string");
  const [gs, gb] = await get("/api/deals/race-pay", buyerKey);
  assert.equal(gs, 200);
  assert.equal(gb.state, "ESCROW_LOCKED");
});

test("stress: delivery is seller-only", async () => {
  await toAgreed("role-deliver", 40);
  assert.equal((await post("/api/deals/role-deliver/pay", {}, freshKey(), buyerKey))[0], 200);
  const [s, b] = await post(
    "/api/deals/role-deliver/delivery",
    { id: "d1", deliveryUrl: "deliverable:buyer-sneak" },
    freshKey(),
    buyerKey,
  );
  assert.equal(s, 403);
  assert.equal(b.error.code, "FORBIDDEN");
});

test("stress: pay is buyer-only", async () => {
  await toAgreed("role-pay", 40);
  const [s, b] = await post("/api/deals/role-pay/pay", {}, freshKey(), sellerKey);
  assert.equal(s, 403);
  assert.equal(b.error.code, "FORBIDDEN");
  assert.match(b.error.message, /only the buyer/);
  // The seller's attempt captured nothing: the buyer still can.
  assert.equal((await post("/api/deals/role-pay/pay", {}, freshKey(), buyerKey))[0], 200);
});

test("stress: deal detail is party-scoped with an admin exception", async () => {
  await toAgreed("role-read", 40);
  const [ss, sb] = await get("/api/deals/role-read", spyKey);
  assert.equal(ss, 403);
  assert.equal(sb.error.code, "FORBIDDEN");
  const [bs] = await get("/api/deals/role-read", buyerKey);
  assert.equal(bs, 200);
  const [ss2] = await get("/api/deals/role-read", sellerKey);
  assert.equal(ss2, 200);
  const [ks] = await get("/api/deals/role-read");
  assert.equal(ks, 401);
  const [as] = await get("/api/deals/role-read", undefined, true);
  assert.equal(as, 200);
  const [ns] = await get("/api/deals/no-such", buyerKey);
  assert.equal(ns, 404);
});

test("stress: state bypasses fail closed", async () => {
  // ACCEPT on SETTLED: run a full walk first (opaque deliverable settles
  // via the mock inspector, same pattern as admin stats).
  await toAgreed("role-settled", 30);
  assert.equal((await post("/api/deals/role-settled/pay", {}, freshKey(), buyerKey))[0], 200);
  const [ds] = await post(
    "/api/deals/role-settled/delivery",
    { id: "d1", deliveryUrl: "deliverable:stress-done" },
    freshKey(),
    sellerKey,
  );
  assert.equal(ds, 202);
  assert.equal((await waitForState("role-settled", ["SETTLED"])).state, "SETTLED");
  const [as, ab] = await post("/api/deals/role-settled/moves", { key: "k3", kind: "ACCEPT", price: 30 }, freshKey(), sellerKey);
  assert.equal(as, 409);
  assert.equal(ab.error.code, "WRONG_STATE");
  // PAY before ACCEPT: 402, not a generic 400.
  const [os] = await post("/api/deals", { id: "role-early", buyer: "s-buyer", seller: "s-seller", price: 20 }, freshKey(), buyerKey);
  assert.equal(os, 200);
  const [ps, pb] = await post("/api/deals/role-early/pay", {}, freshKey(), buyerKey);
  assert.equal(ps, 402);
  assert.equal(pb.error.code, "NEEDS_ACCEPTANCE");
  // DELIVER before PAY: AGREED escrow is not captured escrow.
  await toAgreed("role-unpaid", 20);
  const [vs, vb] = await post(
    "/api/deals/role-unpaid/delivery",
    { id: "d1", deliveryUrl: "deliverable:walk-in" },
    freshKey(),
    sellerKey,
  );
  assert.equal(vs, 409);
  assert.equal(vb.error.code, "MUST_PAY_BEFORE_DELIVERY");
});

test("stress: idempotency keys are scoped per agent", async () => {
  // Same key string, two agents, two deals: independent slots, both 200.
  const [as, ab] = await post("/api/deals", { id: "idem-a", buyer: "s-buyer", seller: "s-seller", price: 10 }, "shared-key", buyerKey);
  const [bs, bb] = await post("/api/deals", { id: "idem-b", buyer: "s-spy", seller: "s-seller", price: 10 }, "shared-key", spyKey);
  assert.equal(as, 200);
  assert.equal(bs, 200);
  assert.equal(ab.result.deal.id, "idem-a");
  assert.equal(bb.result.deal.id, "idem-b");
  // Same agent + same key replays the first receipt instead of opening again.
  const [rs, rb] = await post("/api/deals", { id: "idem-a2", buyer: "s-buyer", seller: "s-seller", price: 10 }, "shared-key", buyerKey);
  assert.equal(rs, 200);
  assert.equal(rb.result.deal.id, "idem-a");
  const [, missing] = await get("/api/deals/idem-a2", buyerKey);
  assert.equal(missing.error.code, "NO_SUCH_DEAL");
});
