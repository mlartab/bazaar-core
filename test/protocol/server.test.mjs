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
let buyerKey;
let sellerKey;

const freshKey = () => `key-${(n += 1)}`;

// Mutating protocol routes authenticate the caller: the key defaults to the
// buyer's, and registration calls pass none (keys are undefined until
// before() captures them, which is exactly when no key is needed).
async function post(p, body, k = freshKey(), agentKey = buyerKey) {
  const headers = { "content-type": "application/json", "idempotency-key": k };
  if (agentKey !== undefined) headers["x-agent-key"] = agentKey;
  const res = await fetch(url + p, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return [res.status, await res.json()];
}

async function postNoKey(p, body, agentKey = buyerKey) {
  const headers = { "content-type": "application/json" };
  if (agentKey !== undefined) headers["x-agent-key"] = agentKey;
  const res = await fetch(url + p, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return [res.status, await res.json()];
}

async function get(p, agentKey = buyerKey) {
  const headers = agentKey === undefined ? {} : { "x-agent-key": agentKey };
  const res = await fetch(url + p, { headers });
  return [res.status, await res.json()];
}

// The inspector settles in the background after the 202: poll the deal
// until it leaves VERIFYING or the budget runs out.
async function waitForState(id, states, agentKey = buyerKey, tries = 50) {
  for (let i = 0; i < tries; i += 1) {
    const [status, body] = await get(`/api/deals/${id}`, agentKey);
    assert.equal(status, 200);
    if (states.includes(body.state)) return body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`deal ${id} never reached ${states.join("/")}`);
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
  buyerKey = b1.result.api_key;
  const [s2, b2] = await post("/api/agents", { id: "seller", role: "seller" });
  assert.equal(s2, 200);
  assertOk(b2);
  sellerKey = b2.result.api_key;
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

test("protocol: server lists agents with capabilities", async () => {
  const [s0, b0] = await post("/api/agents", { id: "seller2", role: "seller", capability: "GPU rendering" });
  assert.equal(s0, 200);
  assertOk(b0);
  // POST response shape is frozen for existing readers: no capability field,
  // only the queue notice beside it.
  assert.deepEqual(b0.result.agent, { id: "seller2", role: "seller", balance: 0 });
  assert.equal(b0.result.message, "Agent registered successfully. Your listing is currently in the review queue.");
  // Fresh listings are pending, so the public list hides them until approval.
  const hidden = await (await fetch(url + "/api/agents")).json();
  assert.ok(!hidden.result.agents.some((a) => a.id === "seller2"));
  process.env.ADMIN_SECRET = "test-admin-secret";
  const approve = await fetch(url + "/api/admin/agents/seller2/approve", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "approve-seller2", authorization: "Bearer test-admin-secret" },
    body: JSON.stringify({ message: "looks good" }),
  });
  assert.equal(approve.status, 200);
  const res = await fetch(url + "/api/agents");
  assert.equal(res.status, 200);
  const body = await res.json();
  assertOk(body);
  const byId = Object.fromEntries(body.result.agents.map((a) => [a.id, a]));
  assert.equal(byId["seller2"].capability, "GPU rendering");
  for (const agent of body.result.agents) {
    for (const field of ["id", "role", "capability"]) {
      assert.ok(field in agent, field);
    }
  }
});

test("protocol: server accepts a POST without an idempotency key", async () => {
  // The header is optional HTTP plumbing: the protocol auto-generates a
  // deterministic key, so the request succeeds without one.
  const [status, body] = await postNoKey("/api/agents", { id: "ghost", role: "buyer" }, undefined);
  assert.equal(status, 200);
  assertOk(body);
});

test("protocol: server replays a rapid identical keyless retry", async () => {
  const deal = { id: "d-autoidem", buyer: "buyer", seller: "seller", price: 50, metadata: { prompt: "paint a mural" } };
  const [status, body] = await postNoKey("/api/deals", deal);
  assert.equal(status, 200);
  assertOk(body);
  assert.equal(body.result.deal.id, "d-autoidem");
  // Rapid identical retry (no header): replays the cached result instead
  // of failing as DUPLICATE_DEAL.
  const [status2, body2] = await postNoKey("/api/deals", { ...deal });
  assert.equal(status2, 200);
  assert.deepEqual(body2, body);
  // The brief round-trips on the stored deal.
  const [gs, gb] = await get("/api/deals/d-autoidem");
  assert.equal(gs, 200);
  assert.deepEqual(gb.result.deal.metadata, { prompt: "paint a mural" });
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
  assert.equal(status, 409);
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

test("protocol: server accepts delivery with 202 and the inspector settles", async () => {
  await post("/api/deals", { id: "d-settle", buyer: "buyer", seller: "seller", price: 50 });
  await post("/api/deals/d-settle/moves", { key: "k1", kind: "OFFER", price: 50 });
  await post("/api/deals/d-settle/moves", { key: "k2", kind: "ACCEPT", price: 40 });
  await post("/api/deals/d-settle/pay", {});
  // Delivery is seller-only: the submit carries the seller's key.
  const [status, body] = await post(
    "/api/deals/d-settle/delivery",
    { id: "del-1", dealId: "d-settle", deliveryUrl: "deliverable:del-1" },
    freshKey(),
    sellerKey,
  );
  assert.equal(status, 202);
  assertOk(body);
  assert.equal(body.state, "VERIFYING");
  assert.deepEqual(body.result.delivery, { id: "del-1", dealId: "d-settle", deliveryUrl: "deliverable:del-1" });
  // The chained walk emitted one event per hop on the way to VERIFYING.
  const settled = await waitForState("d-settle", ["SETTLED"]);
  assert.equal(settled.state, "SETTLED");
  const [, eb] = await get("/api/events");
  const paid = eb.result.events.find((e) => e.type === "SETTLED" && e.dealId === "d-settle");
  assert.deepEqual(paid.paid, 40);
});

test("protocol: delivery walks every hop with one STATE event each", async () => {
  await post("/api/deals", { id: "d-walk", buyer: "buyer", seller: "seller", price: 50 });
  await post("/api/deals/d-walk/moves", { key: "k1", kind: "OFFER", price: 50 });
  await post("/api/deals/d-walk/moves", { key: "k2", kind: "ACCEPT", price: 40 });
  await post("/api/deals/d-walk/pay", {});
  const [status] = await post(
    "/api/deals/d-walk/delivery",
    { id: "del-walk", dealId: "d-walk", deliveryUrl: "deliverable:walk" },
    freshKey(),
    sellerKey,
  );
  assert.equal(status, 202);
  // The walk hops must appear in order in the feed (a later background
  // verdict may append more STATE events after them — hence subsequence,
  // not exact equality).
  const [, eb] = await get("/api/events");
  const hops = eb.result.events
    .filter((e) => e.type === "STATE" && e.dealId === "d-walk")
    .map((e) => `${e.from}->${e.to}`)
    .join("\n");
  const want = ["ESCROW_LOCKED->EXECUTING", "EXECUTING->DELIVERED", "DELIVERED->VERIFYING"].join("\n");
  assert.ok(hops.includes(want), `walk hops out of order:\n${hops}`);
});

test("protocol: server rejects delivery before pay with MUST_PAY_BEFORE_DELIVERY", async () => {
  await post("/api/deals", { id: "d-nopay", buyer: "buyer", seller: "seller", price: 50 });
  await post("/api/deals/d-nopay/moves", { key: "k1", kind: "OFFER", price: 50 });
  await post("/api/deals/d-nopay/moves", { key: "k2", kind: "ACCEPT", price: 40 });
  const [status, body] = await post(
    "/api/deals/d-nopay/delivery",
    { id: "del-1", dealId: "d-nopay", deliveryUrl: "deliverable:x" },
    freshKey(),
    sellerKey,
  );
  assert.equal(status, 409);
  assertErr(body, "MUST_PAY_BEFORE_DELIVERY");
});

test("protocol: server rejects a duplicate delivery id with 409, not a 500", async () => {
  await post("/api/deals", { id: "d-dupdel", buyer: "buyer", seller: "seller", price: 50 });
  await post("/api/deals/d-dupdel/moves", { key: "k1", kind: "OFFER", price: 50 });
  await post("/api/deals/d-dupdel/moves", { key: "k2", kind: "ACCEPT", price: 40 });
  await post("/api/deals/d-dupdel/pay", {});
  const first = { id: "del-dup", dealId: "d-dupdel", deliveryUrl: "deliverable:dup" };
  const [s1] = await post("/api/deals/d-dupdel/delivery", first, freshKey(), sellerKey);
  assert.equal(s1, 202);
  // Delivery ids are globally unique: the same id on a second live escrow
  // hits the record check while still ESCROW_LOCKED.
  await post("/api/deals", { id: "d-dupdel-b", buyer: "buyer", seller: "seller", price: 50 });
  await post("/api/deals/d-dupdel-b/moves", { key: "k1", kind: "OFFER", price: 50 });
  await post("/api/deals/d-dupdel-b/moves", { key: "k2", kind: "ACCEPT", price: 40 });
  await post("/api/deals/d-dupdel-b/pay", {});
  const [s2, b2] = await post(
    "/api/deals/d-dupdel-b/delivery",
    { id: "del-dup", dealId: "d-dupdel-b", deliveryUrl: "deliverable:dup" },
    freshKey(),
    sellerKey,
  );
  assert.equal(s2, 409);
  assertErr(b2, "DUPLICATE_DELIVERY");
  // The rejected call moved nothing: the second deal is still locked.
  const [gs, gb] = await get("/api/deals/d-dupdel-b");
  assert.equal(gs, 200);
  assert.equal(gb.state, "ESCROW_LOCKED");
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

test("protocol: agent discovery filters by skill, service_type, and max_price", async () => {
  process.env.ADMIN_SECRET = "test-admin-secret";
  const register = async (body) => {
    const [s, b] = await post("/api/agents", body);
    assert.equal(s, 200, body.id);
    return b.result.api_key;
  };
  await register({ id: "filt-neg", role: "seller", service_type: "negotiation", price: 200, min_price: 50, skills: ["react", "node"], metadata: { portfolio: "https://example.com/work" } });
  await register({ id: "filt-ep", role: "seller", service_type: "endpoint", price: 80, skills: ["react"] });
  await register({ id: "filt-compute", role: "seller", service_type: "compute", price: 500, skills: ["python"] });
  for (const [i, id] of ["filt-neg", "filt-ep", "filt-compute"].entries()) {
    const approved = await fetch(url + `/api/admin/agents/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `approve-filt-${i}`, authorization: "Bearer test-admin-secret" },
      body: JSON.stringify({ message: "listed" }),
    });
    assert.equal(approved.status, 200, id);
  }
  const list = async (q) => {
    const res = await fetch(url + `/api/agents${q}`);
    assert.equal(res.status, 200, q);
    return (await res.json()).result.agents;
  };
  const bySkill = await list("?skill=react");
  assert.ok(bySkill.some((a) => a.id === "filt-neg"));
  assert.ok(bySkill.some((a) => a.id === "filt-ep"));
  assert.ok(!bySkill.some((a) => a.id === "filt-compute"));
  // Exact tags only: a substring must not match.
  assert.ok(!(await list("?skill=reac")).some((a) => a.id === "filt-neg"));
  const byType = await list("?service_type=negotiation");
  assert.ok(byType.some((a) => a.id === "filt-neg"));
  assert.ok(!byType.some((a) => a.id === "filt-ep"));
  // Negotiation resolves to its floor (50), endpoints to list price (80).
  const cheap = await list("?max_price=90");
  const cheapIds = cheap.map((a) => a.id);
  assert.ok(cheapIds.includes("filt-neg") && cheapIds.includes("filt-ep"));
  assert.ok(!cheapIds.includes("filt-compute"));
  const cheapest = await list("?max_price=40");
  assert.ok(!cheapest.some((a) => ["filt-neg", "filt-ep", "filt-compute"].includes(a.id)));
  // Combined filters narrow to one row with the strategy columns present.
  const one = await list("?skill=react&service_type=endpoint&max_price=90");
  assert.deepEqual(one.map((a) => a.id), ["filt-ep"]);
  // Strategy columns ride alongside the existing storefront fields.
  const neg = (await list("?skill=node")).find((a) => a.id === "filt-neg");
  assert.deepEqual(neg.skills, ["react", "node"]);
  assert.equal(neg.service_type, "negotiation");
  assert.equal(neg.min_price, 50);
  assert.equal(neg.price, 200);
  assert.deepEqual(neg.metadata, { portfolio: "https://example.com/work" });
  // Unknown strategy and non-integer ceilings are caller errors, not filters.
  assert.equal((await fetch(url + "/api/agents?service_type=auction")).status, 400);
  assert.equal((await fetch(url + "/api/agents?max_price=abc")).status, 400);
  assert.equal((await fetch(url + "/api/agents?max_price=0")).status, 400);
});
