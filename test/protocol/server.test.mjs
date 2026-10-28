import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../../protocol/server.js";
import { MENU } from "../../src/menu.js";

// The sandbox sets HTTP(S)_PROXY for external traffic; loopback test
// traffic must bypass it or fetch tunnels 127.0.0.1 through the proxy.
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";

let url;
let stop;
let dir;
let n = 0;

const freshKey = () => `key-${(n += 1)}`;

async function post(p, body, k = freshKey()) {
  const res = await fetch(url + p, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": k },
    body: JSON.stringify(body),
  });
  return [res.status, await res.json()];
}

async function postNoKey(p, body) {
  const res = await fetch(url + p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return [res.status, await res.json()];
}

async function get(p) {
  const res = await fetch(url + p);
  return [res.status, await res.json()];
}

function assertOk(body) {
  assert.equal(body.ok, true);
  assert.ok("state" in body);
  assert.ok("allowedMoves" in body);
  assert.ok("result" in body);
}

function assertErr(body, code) {
  assert.equal(body.ok, false);
  assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, "string");
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazaar-server-"));
  const started = await startServer({ dbPath: path.join(dir, "store.db"), port: 0 });
  url = started.url;
  stop = started.close;
  const [s1, b1] = await post("/api/agents", { id: "buyer", role: "buyer" });
  assert.equal(s1, 200);
  assertOk(b1);
  const [s2, b2] = await post("/api/agents", { id: "seller", role: "seller" });
  assert.equal(s2, 200);
  assertOk(b2);
});

after(async () => {
  await stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("protocol: server registers an agent", async () => {
  const [status, body] = await post("/api/agents", { id: "buyer2", role: "buyer" });
  assert.equal(status, 200);
  assertOk(body);
  assert.deepEqual(body.result.agent, { id: "buyer2", role: "buyer", balance: 0 });
});

test("protocol: server rejects a POST without an idempotency key", async () => {
  const [status, body] = await postNoKey("/api/agents", { id: "ghost", role: "buyer" });
  assert.equal(status, 400);
  assertErr(body, "MISSING_IDEMPOTENCY_KEY");
});

test("protocol: server rejects a bad schema", async () => {
  const [s1, b1] = await post("/api/agents", { id: "no-role" });
  assert.equal(s1, 400);
  assertErr(b1, "INVALID_SCHEMA");
  const [s2, b2] = await post("/api/deals/d添/moves", { key: "k", kind: "OFFER" });
  assert.equal(s2, 404);
  assertErr(b2, "NO_SUCH_DEAL");
});

test("protocol: server opens a deal and reads it back", async () => {
  const [status, body] = await post("/api/deals", { id: "d-open", buyer: "buyer", seller: "seller", price: 50 });
  assert.equal(status, 200);
  assertOk(body);
  assert.equal(body.state, "NEGOTIATING");
  assert.deepEqual(body.allowedMoves, {
    buyer: ["OFFER", "ACCEPT", "WALK"],
    seller: ["OFFER", "ACCEPT", "WALK"],
  });
  const [gs, gb] = await get("/api/deals/d-open");
  assert.equal(gs, 200);
  assertOk(gb);
  assert.equal(gb.result.deal.state, "NEGOTIATING");
  assert.deepEqual(gb.result.moves, []);
});

test("protocol: server records OFFER then ACCEPT moves", async () => {
  await post("/api/deals", { id: "d-moves", buyer: "buyer", seller: "seller", price: 50 });
  const [s1, b1] = await post("/api/deals/d-moves/moves", { key: "k1", kind: "OFFER", price: 50 });
  assert.equal(s1, 200);
  assertOk(b1);
  assert.equal(b1.state, "NEGOTIATING");
  const [s2, b2] = await post("/api/deals/d-moves/moves", { key: "k2", kind: "ACCEPT", price: 40 });
  assert.equal(s2, 200);
  assertOk(b2);
  assert.equal(b2.state, "AGREED");
  const [, gb] = await get("/api/deals/d-moves");
  assert.equal(gb.result.moves.length, 2);
});

test("protocol: server rejects a duplicate move key", async () => {
  await post("/api/deals", { id: "d-dup", buyer: "buyer", seller: "seller", price: 50 });
  const [s1] = await post("/api/deals/d-dup/moves", { key: "k1", kind: "OFFER", price: 50 });
  assert.equal(s1, 200);
  const [s2, b2] = await post("/api/deals/d-dup/moves", { key: "k1", kind: "OFFER", price: 60 });
  assert.equal(s2, 400);
  assertErr(b2, "DUPLICATE_MOVE");
});

test("protocol: server rejects an off-menu move", async () => {
  await post("/api/deals", { id: "d-menu", buyer: "buyer", seller: "seller", price: 50 });
  const saved = MENU.NEGOTIATING.buyer;
  MENU.NEGOTIATING.buyer = ["OFFER", "ACCEPT"];
  try {
    const [status, body] = await post("/api/deals/d-menu/moves", { key: "w1", kind: "WALK" });
    assert.equal(status, 400);
    assertErr(body, "OFF_MENU");
  } finally {
    MENU.NEGOTIATING.buyer = saved;
  }
  const [status] = await post("/api/deals/d-menu/moves", { key: "w1", kind: "WALK" });
  assert.equal(status, 200);
});

test("protocol: server rejects a move in the wrong state", async () => {
  await post("/api/deals", { id: "d-state", buyer: "buyer", seller: "seller", price: 50 });
  await post("/api/deals/d-state/moves", { key: "k1", kind: "OFFER", price: 50 });
  await post("/api/deals/d-state/moves", { key: "k2", kind: "ACCEPT", price: 40 });
  const [status, body] = await post("/api/deals/d-state/moves", { key: "k3", kind: "OFFER", price: 40 });
  assert.equal(status, 400);
  assertErr(body, "WRONG_STATE");
});

test("protocol: server rejects schema violations on moves", async () => {
  await post("/api/deals", { id: "d-schema", buyer: "buyer", seller: "seller", price: 50 });
  const [s1, b1] = await post("/api/deals/d-schema/moves", { key: "k1", kind: "OFFER" });
  assert.equal(s1, 400);
  assertErr(b1, "INVALID_SCHEMA");
  const [s2, b2] = await post("/api/deals/d-schema/moves", { key: "k2", kind: "WALK", price: 10 });
  assert.equal(s2, 400);
  assertErr(b2, "INVALID_SCHEMA");
});

test("protocol: server runs delivery to SETTLED and pays the seller", async () => {
  await post("/api/deals", { id: "d-settle", buyer: "buyer", seller: "seller", price: 50 });
  await post("/api/deals/d-settle/moves", { key: "k1", kind: "OFFER", price: 50 });
  await post("/api/deals/d-settle/moves", { key: "k2", kind: "ACCEPT", price: 40 });
  const states = [];
  for (let i = 1; i <= 4; i += 1) {
    const [status, body] = await post("/api/deals/d-settle/delivery", {
      id: `del-${i}`,
      dealId: "d-settle",
      status: "SENT",
    });
    assert.equal(status, 200);
    states.push(body.state);
  }
  assert.deepEqual(states, ["ESCROW_LOCKED", "EXECUTING", "DELIVERED", "VERIFYING"]);
  const [fs_, fb] = await post("/api/deals/d-settle/delivery", {
    id: "del-5",
    dealId: "d-settle",
    status: "DELIVERED",
  });
  assert.equal(fs_, 200);
  assert.equal(fb.state, "SETTLED");
  const [, eb] = await get("/api/events");
  const settled = eb.result.events.find((e) => e.type === "SETTLED" && e.dealId === "d-settle");
  assert.deepEqual(settled.paid, 40);
});

test("protocol: server replays a repeated idempotency key", async () => {
  const replayKey = freshKey();
  const first = await post("/api/agents", { id: "replay-agent", role: "buyer" }, replayKey);
  const second = await post("/api/agents", { id: "replay-agent", role: "buyer" }, replayKey);
  assert.equal(first[0], 200);
  assert.deepEqual(second[1], first[1]);
});

test("protocol: server lists events", async () => {
  const [status, body] = await get("/api/events");
  assert.equal(status, 200);
  assertOk(body);
  assert.ok(Array.isArray(body.result.events));
  assert.ok(body.result.events.length > 0);
  assert.ok(body.result.events.some((e) => e.type === "DEAL_OPENED"));
});
