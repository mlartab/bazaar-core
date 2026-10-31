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
process.env.ADMIN_SECRET = "test-pay-secret";

let url;
let stop;
let dir;
let n = 0;
let payerKey;
let payeeKey;

const freshKey = () => `paykey-${(n += 1)}`;

// The shared post helper drops headers, and the receipt proof lives in a
// header: this file reads responses raw. The payer's key authenticates every
// mutating call; registration passes none (the key is undefined until
// before() captures it, which is exactly when no key is needed).
async function postRaw(p, body, k = freshKey(), agentKey = payerKey) {
  const headers = { "content-type": "application/json", "idempotency-key": k };
  if (agentKey !== undefined) headers["x-agent-key"] = agentKey;
  const res = await fetch(url + p, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json(), proof: res.headers.get("x-payment-proof") };
}

async function get(p, agentKey = payerKey) {
  const headers = agentKey === undefined ? {} : { "x-agent-key": agentKey };
  const res = await fetch(url + p, { headers });
  return [res.status, await res.json()];
}

async function waitForState(id, states, tries = 50) {
  for (let i = 0; i < tries; i += 1) {
    const [status, body] = await get(`/api/deals/${id}`);
    assert.equal(status, 200);
    if (states.includes(body.state)) return body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`deal ${id} never reached ${states.join("/")}`);
}

function assertErr(body, code) {
  assert.equal(body.ok, false);
  assert.equal(body.error.code, code);
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazaar-pay-"));
  const started = await startServer({ dbPath: path.join(dir, "store.db"), port: 0 });
  url = started.url;
  stop = started.close;
  const buyer = await postRaw("/api/agents", { id: "payer", role: "buyer" });
  assert.equal(buyer.status, 200);
  payerKey = buyer.body.result.api_key;
  const seller = await postRaw("/api/agents", { id: "payee", role: "seller" });
  assert.equal(seller.status, 200);
  payeeKey = seller.body.result.api_key;
  // Commerce requires ACTIVE counterparties.
  for (const id of ["payer", "payee"]) {
    const approved = await fetch(url + `/api/admin/agents/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": freshKey(), authorization: `Bearer ${process.env.ADMIN_SECRET}` },
      body: JSON.stringify({}),
    });
    assert.equal(approved.status, 200, id);
  }
});

after(async () => {
  await stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function agreedDeal(id, price) {
  // The opening deposit funds the buyer's budget, so the deal opens at the
  // offer price and acceptance settles lower — the brick-5 50/40 pattern.
  const opened = await postRaw("/api/deals", { id, buyer: "payer", seller: "payee", price: price + 10 });
  assert.equal(opened.status, 200);
  assert.equal(opened.body.state, "NEGOTIATING");
  const offered = await postRaw(`/api/deals/${id}/moves`, { key: "k1", kind: "OFFER", price: price + 10 });
  assert.equal(offered.status, 200);
  const accepted = await postRaw(`/api/deals/${id}/moves`, { key: "k2", kind: "ACCEPT", price });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.state, "AGREED");
}

test("protocol: pay on AGREED locks the escrow and returns the x402 receipt", async () => {
  await agreedDeal("d-pay", 40);
  const paid = await postRaw("/api/deals/d-pay/pay", {});
  assert.equal(paid.status, 200);
  assert.equal(paid.body.ok, true);
  assert.equal(paid.body.state, "ESCROW_LOCKED");
  // Proof lives in two places that must agree: the header the client
  // keeps, and the body the client renders.
  assert.ok(typeof paid.proof === "string" && paid.proof.startsWith("x402-receipt-"));
  assert.equal(paid.body.result.receipt, paid.proof);
  // Truthful amount: the ACCEPT locked 40 on a 50-price deal, so the event
  // reports the lock — never the listing price.
  const [, eb] = await get("/api/events");
  const locked = eb.result.events.find((e) => e.type === "ESCROW_LOCKED" && e.dealId === "d-pay");
  assert.deepEqual(locked.amount, 40);
  // Capture feeds the async settlement path: one delivery submit parks
  // the deal in VERIFYING (202) and the inspector pays the seller exactly
  // once in the background.
  const delivered = await postRaw("/api/deals/d-pay/delivery", { id: "pay-del-1", dealId: "d-pay", deliveryUrl: "deliverable:pay" }, freshKey(), payeeKey);
  assert.equal(delivered.status, 202);
  assert.equal(delivered.body.state, "VERIFYING");
  const final = await waitForState("d-pay", ["SETTLED"]);
  assert.equal(final.state, "SETTLED");
});

test("protocol: pay on NEGOTIATING answers 402 NEEDS_ACCEPTANCE", async () => {
  const opened = await postRaw("/api/deals", { id: "d-early", buyer: "payer", seller: "payee", price: 30 });
  assert.equal(opened.status, 200);
  const paid = await postRaw("/api/deals/d-early/pay", {});
  assert.equal(paid.status, 402);
  assertErr(paid.body, "NEEDS_ACCEPTANCE");
});

test("protocol: a second pay answers 409 without a second lock", async () => {
  await agreedDeal("d-twice", 40);
  const first = await postRaw("/api/deals/d-twice/pay", {});
  assert.equal(first.status, 200);
  const second = await postRaw("/api/deals/d-twice/pay", {});
  assert.equal(second.status, 409);
  assertErr(second.body, "ALREADY_LOCKED");
  // The replay changed nothing: the deal sits in its single lock.
  const [status, body] = await get("/api/deals/d-twice");
  assert.equal(status, 200);
  assert.equal(body.state, "ESCROW_LOCKED");
});

test("protocol: pay errors carry state and allowedMoves for agent self-correction", async () => {
  const early = await postRaw("/api/deals", { id: "d-early-err", buyer: "payer", seller: "payee", price: 30 });
  assert.equal(early.status, 200);
  const needs = await postRaw("/api/deals/d-early-err/pay", {});
  assert.equal(needs.status, 402);
  assertErr(needs.body, "NEEDS_ACCEPTANCE");
  assert.equal(needs.body.state, "NEGOTIATING");
  assert.ok(needs.body.allowedMoves !== undefined && typeof needs.body.allowedMoves === "object");
  assert.ok(Array.isArray(needs.body.allowedMoves.buyer) && needs.body.allowedMoves.buyer.length > 0);
  await agreedDeal("d-twice-err", 40);
  const first = await postRaw("/api/deals/d-twice-err/pay", {});
  assert.equal(first.status, 200);
  const second = await postRaw("/api/deals/d-twice-err/pay", {});
  assert.equal(second.status, 409);
  assertErr(second.body, "ALREADY_LOCKED");
  assert.equal(second.body.state, "ESCROW_LOCKED");
  assert.ok(second.body.allowedMoves !== undefined && typeof second.body.allowedMoves === "object");
});

test("protocol: pay rejects a non-empty body and an unknown deal", async () => {
  const extra = await postRaw("/api/deals/d-twice/pay", { fee: 1 });
  assert.equal(extra.status, 400);
  assertErr(extra.body, "INVALID_SCHEMA");
  const missing = await postRaw("/api/deals/d-ghost/pay", {});
  assert.equal(missing.status, 404);
  assertErr(missing.body, "NO_SUCH_DEAL");
});
