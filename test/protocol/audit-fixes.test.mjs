import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../../protocol/db.js";
import { createLedger } from "../../src/ledger.js";
import { transition } from "../../src/deal-states.js";
import { startServer } from "../../protocol/server.js";
import { runInspection } from "../../protocol/inspector.js";

process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";
process.env.ADMIN_SECRET = "test-audit-fixes-secret";

let url;
let stop;
let dir;
let n = 0;
const freshKey = () => `audit-${(n += 1)}`;

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

async function approve(id) {
  const res = await fetch(url + `/api/admin/agents/${id}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.ADMIN_SECRET}`, "idempotency-key": freshKey() },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200, `approve ${id}`);
}

let buyerKey;
let sellerKey;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazaar-audit-"));
  const started = await startServer({ dbPath: path.join(dir, "store.db"), port: 0 });
  url = started.url;
  stop = started.close;
  buyerKey = (await post("/api/agents", { id: "ab", role: "buyer" }))[1].result.api_key;
  sellerKey = (await post("/api/agents", { id: "as", role: "seller" }))[1].result.api_key;
  await approve("ab");
  await approve("as");
});

after(async () => {
  await stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("audit: suspended seller in-flight deal freezes instead of settling", async () => {
  const saved = process.env.MODEL_API_KEY;
  delete process.env.MODEL_API_KEY;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bazaar-audit-frozen-"));
  const store = openStore(path.join(d, "store.db"));
  try {
    store.saveAgent({ id: "fb", role: "buyer", status: "ACTIVE" });
    store.saveAgent({ id: "fs", role: "seller", status: "SUSPENDED", status_reason: "abuse" });
    store.saveDeal({ id: "f-deal", state: "VERIFYING", buyer: "fb", seller: "fs", price: 10 });
    const ledger = createLedger();
    ledger.balances.fb = 0;
    ledger.balances.fs = 0;
    ledger.reserve = 10;
    ledger.locks["f-deal"] = { agentId: "fb", amount: 10 };
    const events = [];
    const result = await runInspection({
      store, ledger, dealId: "f-deal", deliveryUrl: "deliverable:x",
      emit: (e) => events.push(e), log: console,
    });
    assert.equal(result.ok, false);
    assert.equal(store.getDeal("f-deal").state, "VERIFYING");
    assert.deepEqual(ledger.locks["f-deal"], { agentId: "fb", amount: 10 });
    assert.equal(ledger.balances.fs, 0);
  } finally {
    store.close();
    fs.rmSync(d, { recursive: true, force: true });
    if (saved === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = saved;
  }
});

test("audit: sweeper rejections are legal machine transitions", () => {
  for (const from of ["NEGOTIATING", "AGREED", "ESCROW_LOCKED", "VERIFYING"]) {
    const r = transition({ state: from }, "REJECTED");
    assert.equal(r.ok, true, `${from} -> REJECTED`);
  }
});

test("audit: delivery 409 carries state and allowedMoves", async () => {
  await post("/api/deals", { id: "ad-1", buyer: "ab", seller: "as", price: 60 }, buyerKey);
  const [status, body] = await post("/api/deals/ad-1/delivery", { id: "ad-d1", dealId: "ad-1", deliveryUrl: "deliverable:x" }, sellerKey);
  assert.equal(status, 409);
  assert.equal(body.state, "NEGOTIATING");
  assert.ok(body.allowedMoves !== undefined);
});

test("audit: duplicate ACCEPT carries state and allowedMoves", async () => {
  await post("/api/deals", { id: "ad-2", buyer: "ab", seller: "as", price: 60 }, buyerKey);
  await post("/api/deals/ad-2/moves", { key: "k1", kind: "OFFER", price: 60 }, buyerKey);
  await post("/api/deals/ad-2/moves", { key: "k2", kind: "ACCEPT", price: 50 }, sellerKey);
  const [status, body] = await post("/api/deals/ad-2/moves", { key: "k3", kind: "ACCEPT", price: 50 }, sellerKey);
  assert.equal(status, 409);
  assert.equal(body.state, "AGREED");
  assert.ok(body.allowedMoves !== undefined);
});

test("audit: responses name the caller role and who is waited on", async () => {
  const [, detail] = await get("/api/deals/ad-1", buyerKey);
  assert.equal(detail.yourRole, "buyer");
  assert.ok(typeof detail.waitingOn === "string" && detail.waitingOn.length > 0);
  const [, mv] = await post("/api/deals/ad-1/moves", { key: "k1", kind: "OFFER", price: 55 }, buyerKey);
  assert.equal(mv.yourRole, "buyer");
  assert.ok(typeof mv.waitingOn === "string" && mv.waitingOn.length > 0);
});

test("audit: GET deal shows the locked escrow amount", async () => {
  await post("/api/deals/ad-2/pay", {}, buyerKey);
  const [, detail] = await get("/api/deals/ad-2", buyerKey);
  assert.equal(detail.result.escrow, 50);
  const [, neg] = await get("/api/deals/ad-1", buyerKey);
  assert.equal(neg.result.escrow, null);
});

async function adminPost(p, body = {}) {
  const res = await fetch(url + p, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.ADMIN_SECRET}`, "idempotency-key": freshKey() },
    body: JSON.stringify(body),
  });
  return [res.status, await res.json()];
}

async function suspend(id) {
  const [status] = await adminPost(`/api/admin/agents/${id}/suspend`, { reason: "audit freeze test" });
  assert.equal(status, 200, `suspend ${id}`);
}

async function pollFrozen(dealId, agentKey) {
  for (let i = 0; i < 100; i += 1) {
    const [, body] = await get("/api/events", agentKey);
    if (body.result.events.some((e) => e.type === "SETTLEMENT_FROZEN" && e.dealId === dealId)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// Suspend BEFORE delivery so the single background inspection the
// delivery triggers is guaranteed to observe the suspension and freeze.
async function setupFrozenDeal(tag, price) {
  const buyer = `${tag}-buyer`;
  const seller = `${tag}-seller`;
  const dealId = `${tag}-deal`;
  const buyerKey = (await post("/api/agents", { id: buyer, role: "buyer" }))[1].result.api_key;
  const sellerKey = (await post("/api/agents", { id: seller, role: "seller" }))[1].result.api_key;
  await approve(buyer);
  await approve(seller);
  const preBuyer = (await get("/api/me", buyerKey))[1].result.balance;
  const preSeller = (await get("/api/me", sellerKey))[1].result.balance;
  assert.equal((await post("/api/deals", { id: dealId, buyer, seller, price }, buyerKey))[0], 200);
  assert.equal((await post(`/api/deals/${dealId}/moves`, { key: "k1", kind: "OFFER", price }, buyerKey))[0], 200);
  assert.equal((await post(`/api/deals/${dealId}/moves`, { key: "k2", kind: "ACCEPT", price }, sellerKey))[0], 200);
  assert.equal((await post(`/api/deals/${dealId}/pay`, {}, buyerKey))[0], 200);
  await suspend(seller);
  assert.equal((await post(`/api/deals/${dealId}/delivery`, { id: `${tag}-del`, dealId, deliveryUrl: "deliverable:x" }, sellerKey))[0], 202);
  assert.equal(await pollFrozen(dealId, buyerKey), true, "inspection froze the deal");
  const [, frozen] = await get(`/api/deals/${dealId}`, buyerKey);
  assert.equal(frozen.state, "VERIFYING");
  assert.equal(frozen.result.escrow, price);
  return { buyer, seller, dealId, buyerKey, sellerKey, preBuyer, preSeller, price };
}

test("audit: admin force-refund resolves a frozen settlement", async () => {
  const saved = process.env.MODEL_API_KEY;
  delete process.env.MODEL_API_KEY;
  try {
    const f = await setupFrozenDeal("afr", 60);
    const [status, body] = await adminPost(`/api/admin/deals/${f.dealId}/force-refund`);
    assert.equal(status, 200);
    assert.equal(body.state, "REJECTED");
    assert.equal(body.result.close_reason, "ADMIN_FORCE_REFUND");
    const [, detail] = await get(`/api/deals/${f.dealId}`, f.buyerKey);
    assert.equal(detail.state, "REJECTED");
    assert.equal(detail.result.verdict.close_reason, "ADMIN_FORCE_REFUND");
    assert.equal(detail.result.escrow, null);
    assert.equal(body.result.refunded, f.price);
    const [, feed] = await get("/api/events", f.buyerKey);
    const refunded = feed.result.events.find((e) => e.type === "REFUNDED" && e.dealId === f.dealId);
    assert.deepEqual(refunded?.refunded, f.price);
    // The seller is never paid on this path: no SETTLED event exists.
    assert.equal(feed.result.events.some((e) => e.type === "SETTLED" && e.dealId === f.dealId), false);
  } finally {
    if (saved === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = saved;
  }
});

test("audit: admin reinspect settles after seller reinstated", async () => {
  const saved = process.env.MODEL_API_KEY;
  delete process.env.MODEL_API_KEY;
  try {
    const f = await setupFrozenDeal("ars", 70);
    await approve(f.seller);
    const [status, body] = await adminPost(`/api/admin/deals/${f.dealId}/reinspect`);
    assert.equal(status, 200);
    assert.equal(body.state, "SETTLED");
    assert.equal(body.result.to, "SETTLED");
    const [, feed] = await get("/api/events", f.buyerKey);
    const paid = feed.result.events.find((e) => e.type === "SETTLED" && e.dealId === f.dealId);
    assert.deepEqual(paid?.paid, f.price);
    const [, detail] = await get(`/api/deals/${f.dealId}`, f.buyerKey);
    assert.equal(detail.result.escrow, null);
  } finally {
    if (saved === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = saved;
  }
});
