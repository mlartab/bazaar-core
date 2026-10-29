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
process.env.ADMIN_SECRET = "test-admin-secret";

let url;
let stop;
let dir;
let n = 0;

const freshKey = () => `admin-${(n += 1)}`;

let buyerKey;
let sellerKey;

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

async function get(p, agentKey = buyerKey) {
  const headers = agentKey === undefined ? {} : { "x-agent-key": agentKey };
  const res = await fetch(url + p, { headers });
  return [res.status, await res.json()];
}

async function waitForState(id, states, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const [status, body] = await get(`/api/deals/${id}`);
    assert.equal(status, 200);
    if (states.includes(body.state)) return body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`deal ${id} never reached ${states.join("/")}`);
}

const authHeaders = (secret = "test-admin-secret") => ({ authorization: `Bearer ${secret}` });

async function aget(p, secret) {
  const res = await fetch(url + p, { headers: authHeaders(secret) });
  const text = await res.text();
  try {
    return [res.status, JSON.parse(text)];
  } catch {
    return [res.status, text];
  }
}

function assertOk(body) {
  assert.equal(body.ok, true);
  assert.ok("state" in body);
  assert.ok("allowedMoves" in body);
  assert.ok("result" in body);
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazaar-admin-"));
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

test("protocol: admin rejects requests without a valid admin secret", async () => {
  const [s1, b1] = await get("/api/admin/stats");
  assert.equal(s1, 401);
  assert.equal(b1.ok, false);
  assert.equal(b1.error.code, "UNAUTHORIZED");
  const [s2, b2] = await aget("/api/admin/stats", "wrong-secret");
  assert.equal(s2, 401);
  assert.equal(b2.error.code, "UNAUTHORIZED");
  // Auth runs before routing: unknown admin paths 401 instead of leaking 404s.
  const [s3, b3] = await get("/api/admin/nope");
  assert.equal(s3, 401);
  assert.equal(b3.error.code, "UNAUTHORIZED");
});

test("protocol: admin stats start at zero on an empty store", async () => {
  const [status, body] = await aget("/api/admin/stats");
  assert.equal(status, 200);
  assertOk(body);
  assert.deepEqual(body.result, { totalDeals: 0, activeDeals: 0, tvl: 0, settled: 0, rejected: 0 });
});

test("protocol: admin stats track active, settled, and rejected deals", async () => {
  // Deal A stays AGREED: active, contributes its price to TVL.
  await post("/api/deals", { id: "a-act", buyer: "buyer", seller: "seller", price: 50 });
  await post("/api/deals/a-act/moves", { key: "k1", kind: "OFFER", price: 50 });
  await post("/api/deals/a-act/moves", { key: "k2", kind: "ACCEPT", price: 40 });
  // Deal B runs to SETTLED via pay + async inspection.
  await post("/api/deals", { id: "b-set", buyer: "buyer", seller: "seller", price: 30 });
  await post("/api/deals/b-set/moves", { key: "k1", kind: "OFFER", price: 30 });
  await post("/api/deals/b-set/moves", { key: "k2", kind: "ACCEPT", price: 20 });
  await post("/api/deals/b-set/pay", {});
  const [bs, bb] = await post("/api/deals/b-set/delivery", { id: "b-del-1", dealId: "b-set", deliveryUrl: "deliverable:b" }, freshKey(), sellerKey);
  assert.equal(bs, 202);
  assert.equal(bb.state, "VERIFYING");
  assert.equal((await waitForState("b-set", ["SETTLED"])).state, "SETTLED");
  // Deal C runs to REJECTED: the mock inspector fails references
  // containing reject/fail/invalid.
  await post("/api/deals", { id: "c-rej", buyer: "buyer", seller: "seller", price: 20 });
  await post("/api/deals/c-rej/moves", { key: "k1", kind: "OFFER", price: 20 });
  await post("/api/deals/c-rej/moves", { key: "k2", kind: "ACCEPT", price: 10 });
  await post("/api/deals/c-rej/pay", {});
  const [rs, rb] = await post("/api/deals/c-rej/delivery", { id: "c-del-1", dealId: "c-rej", deliveryUrl: "deliverable:reject-me" }, freshKey(), sellerKey);
  assert.equal(rs, 202);
  assert.equal(rb.state, "VERIFYING");
  assert.equal((await waitForState("c-rej", ["REJECTED"])).state, "REJECTED");

  const [status, body] = await aget("/api/admin/stats");
  assert.equal(status, 200);
  assertOk(body);
  assert.deepEqual(body.result, { totalDeals: 3, activeDeals: 1, tvl: 50, settled: 1, rejected: 1 });
});

test("protocol: admin deals list every deal with created_at", async () => {
  const [status, body] = await aget("/api/admin/deals");
  assert.equal(status, 200);
  assertOk(body);
  assert.equal(body.result.deals.length, 3);
  assert.deepEqual(
    body.result.deals.map((d) => d.id),
    ["a-act", "b-set", "c-rej"],
  );
  for (const deal of body.result.deals) {
    for (const field of ["id", "state", "buyer", "seller", "price", "created_at"]) {
      assert.ok(field in deal, field);
    }
    assert.equal(typeof deal.created_at, "number");
  }
  const byId = Object.fromEntries(body.result.deals.map((d) => [d.id, d]));
  assert.equal(byId["a-act"].state, "AGREED");
  assert.equal(byId["b-set"].state, "SETTLED");
  assert.equal(byId["c-rej"].state, "REJECTED");
});

test("protocol: admin logs return the last 50 requests with correlation ids", async () => {
  for (let i = 0; i < 60; i += 1) {
    const [s] = await get("/api/events");
    assert.equal(s, 200);
  }
  const [status, body] = await aget("/api/admin/logs");
  assert.equal(status, 200);
  assertOk(body);
  assert.equal(body.result.logs.length, 50);
  for (const entry of body.result.logs) {
    assert.equal(typeof entry.correlationId, "string");
    assert.ok(entry.correlationId.length > 0);
    assert.equal(typeof entry.method, "string");
    assert.equal(typeof entry.path, "string");
    assert.equal(typeof entry.status, "number");
    assert.equal(typeof entry.latencyMs, "number");
    assert.ok(entry.latencyMs >= 0);
  }
  // Early history fell off the ring; recent traffic is all 200s to /api/events.
  assert.ok(body.result.logs.every((e) => e.status === 200));
  assert.ok(body.result.logs.every((e) => e.path === "/api/events"));
});

test("protocol: admin dashboard composes stats, deals, and logs", async () => {
  const [status, body] = await aget("/api/admin/dashboard");
  assert.equal(status, 200);
  assertOk(body);
  const [ss, stats] = await aget("/api/admin/stats");
  const [ds, deals] = await aget("/api/admin/deals");
  assert.equal(ss, 200);
  assert.equal(ds, 200);
  assert.deepEqual(body.result.stats, stats.result);
  assert.deepEqual(body.result.deals, deals.result.deals);
  assert.ok(Array.isArray(body.result.logs));
  assert.ok(body.result.logs.length <= 50);
});

test("protocol: admin traffic is not logged", async () => {
  await aget("/api/admin/stats");
  await aget("/api/admin/deals");
  await aget("/api/admin/dashboard");
  const [, body] = await aget("/api/admin/logs");
  assert.ok(body.result.logs.length > 0);
  assert.ok(body.result.logs.every((e) => !e.path.startsWith("/api/admin")));
});

async function moderate(id, verb, body) {
  const res = await fetch(url + `/api/admin/agents/${id}/${verb}`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": freshKey(), authorization: "Bearer test-admin-secret" },
    body: JSON.stringify(body),
  });
  return [res.status, await res.json()];
}

test("protocol: a new agent is hidden until approved", async () => {
  const [s, b] = await post("/api/agents", { id: "pending1", role: "seller", capability: "Video editing" });
  assert.equal(s, 200);
  assert.equal(b.result.message, "Agent registered successfully. Your listing is currently in the review queue.");
  const [, listed] = await get("/api/agents");
  assert.ok(!listed.result.agents.some((a) => a.id === "pending1"));
  const [ss, status] = await get("/api/agents/pending1/status");
  assert.equal(ss, 200);
  assert.deepEqual(status.result, { status: "PENDING", status_reason: null });
});

test("protocol: approving an agent publishes it to the marketplace", async () => {
  const [s, body] = await moderate("pending1", "approve", { message: "verified seller" });
  assert.equal(s, 200);
  // Approval hands the credential to the operator alongside the verdict.
  assert.equal(body.result.status, "ACTIVE");
  assert.equal(body.result.status_reason, "verified seller");
  assert.ok(typeof body.result.api_key === "string" && body.result.api_key.length > 0);
  const [, listed] = await get("/api/agents");
  const row = listed.result.agents.find((a) => a.id === "pending1");
  assert.deepEqual(row, { id: "pending1", role: "seller", balance: 0, capability: "Video editing", title: null, description: null, price: null, category: null });
  const [, status] = await get("/api/agents/pending1/status");
  assert.deepEqual(status.result, { status: "ACTIVE", status_reason: "verified seller" });
  const [, agents] = await aget("/api/admin/agents");
  assert.equal(agents.result.agents.find((a) => a.id === "pending1").status, "ACTIVE");
});

test("protocol: listing fields are length- and range-checked", async () => {
  const long = (n) => "x".repeat(n);
  for (const body of [
    { id: "t1", role: "seller", title: long(101) },
    { id: "t2", role: "seller", description: long(300) },
    { id: "t3", role: "seller", price: -1 },
    { id: "t4", role: "seller", price: 1.5 },
    { id: "t5", role: "seller", price: "50" },
  ]) {
    const [s, b] = await post("/api/agents", body);
    assert.equal(s, 400, JSON.stringify(body).slice(0, 40));
    assert.equal(b.error.code, "INVALID_SCHEMA", JSON.stringify(body).slice(0, 40));
  }
  // Boundary values pass: exactly 100/250 chars and a zero price.
  const [ok, okBody] = await post("/api/agents", {
    id: "t-ok",
    role: "seller",
    title: long(100),
    description: long(250),
    price: 0,
  });
  assert.equal(ok, 200);
  assert.equal(okBody.result.agent.id, "t-ok");
});

test("protocol: a full listing is stored and listed after approval", async () => {
  const [s, b] = await post("/api/agents", {
    id: "listed1",
    role: "seller",
    capability: "Video editing",
    title: "Cinematic Cuts",
    description: "Trailer edits in 48 hours.",
    price: 150,
  });
  assert.equal(s, 200);
  // Frozen POST shape: no listing fields leak into the agent envelope.
  assert.deepEqual(b.result.agent, { id: "listed1", role: "seller", balance: 0 });
  const [, before] = await get("/api/agents");
  assert.ok(!before.result.agents.some((a) => a.id === "listed1"));
  const [actionStatus] = await moderate("listed1", "approve", {});
  assert.equal(actionStatus, 200);
  const [, listed] = await get("/api/agents");
  const row = listed.result.agents.find((a) => a.id === "listed1");
  assert.deepEqual(row, {
    id: "listed1",
    role: "seller",
    balance: 0,
    capability: "Video editing",
    title: "Cinematic Cuts",
    description: "Trailer edits in 48 hours.",
    price: 150,
    category: null,
  });
});

test("protocol: category registers, lists, and rejects out-of-set values", async () => {
  const [bad, badBody] = await post("/api/agents", { id: "cat-bad", role: "seller", category: "podcasts" });
  assert.equal(bad, 400);
  assert.equal(badBody.error.code, "INVALID_SCHEMA");
  const [s] = await post("/api/agents", { id: "cat-good", role: "seller", category: "image_gen" });
  assert.equal(s, 200);
  const [as_] = await moderate("cat-good", "approve", {});
  assert.equal(as_, 200);
  const [, listed] = await get("/api/agents");
  assert.equal(listed.result.agents.find((a) => a.id === "cat-good").category, "image_gen");
});

test("protocol: PATCH edits listing fields and rejects unknowns", async () => {
  const patch = async (id, body) => {
    const res = await fetch(url + `/api/admin/agents/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: "Bearer test-admin-secret" },
      body: JSON.stringify(body),
    });
    return [res.status, await res.json()];
  };
  const [s, b] = await patch("listed1", { title: "Recut", price: 200, category: "video_gen" });
  assert.equal(s, 200);
  assert.equal(b.ok, true);
  const [, listed] = await get("/api/agents");
  const row = listed.result.agents.find((a) => a.id === "listed1");
  assert.equal(row.title, "Recut");
  assert.equal(row.price, 200);
  assert.equal(row.category, "video_gen");
  const [sUnknown, bUnknown] = await patch("listed1", { api_key: "x" });
  assert.equal(sUnknown, 400);
  assert.equal(bUnknown.error.code, "INVALID_SCHEMA");
  const [sEmpty, bEmpty] = await patch("listed1", {});
  assert.equal(sEmpty, 400);
  assert.equal(bEmpty.error.code, "BAD_PATCH");
  const [sMissing] = await patch("ghost", { title: "x" });
  assert.equal(sMissing, 404);
});

test("protocol: DELETE removes agents but refuses live deals", async () => {
  const del = async (id) => {
    const res = await fetch(url + `/api/admin/agents/${id}`, {
      method: "DELETE",
      headers: { authorization: "Bearer test-admin-secret" },
    });
    return [res.status, await res.json()];
  };
  // listed1 has no deals: removable.
  const [s, b] = await del("listed1");
  assert.equal(s, 200);
  assert.deepEqual(b.result, { id: "listed1", deleted: true });
  const [, agents] = await aget("/api/admin/agents");
  assert.ok(!agents.result.agents.some((a) => a.id === "listed1"));
  const [sAgain, bAgain] = await del("listed1");
  assert.equal(sAgain, 404);
  assert.equal(bAgain.error.code, "NO_SUCH_AGENT");
  // pending1 holds a live deal below: refusal first.
  const [os_] = await post("/api/deals", { id: "d-guard", buyer: "buyer", seller: "seller", price: 10 }, buyerKey);
  assert.equal(os_, 200);
  const [sGuard, bGuard] = await del("seller");
  assert.equal(sGuard, 409);
  assert.equal(bGuard.error.code, "AGENT_HAS_LIVE_DEALS");
});

test("protocol: rejecting an agent saves the reason and keeps it hidden", async () => {
  await post("/api/agents", { id: "rejected1", role: "seller" });
  const [s] = await moderate("rejected1", "reject", { reason: "Fake credentials" });
  assert.equal(s, 200);
  const [, listed] = await get("/api/agents");
  assert.ok(!listed.result.agents.some((a) => a.id === "rejected1"));
  const [, status] = await get("/api/agents/rejected1/status");
  assert.deepEqual(status.result, { status: "REJECTED", status_reason: "Fake credentials" });
});

test("protocol: suspending an agent hides it and re-activating restores it", async () => {
  await post("/api/agents", { id: "flip1", role: "seller" });
  const [a1] = await moderate("flip1", "approve", {});
  assert.equal(a1, 200);
  const [, before] = await get("/api/agents");
  assert.ok(before.result.agents.some((a) => a.id === "flip1"));
  const [s, suspended] = await moderate("flip1", "suspend", { reason: "Abuse reports" });
  assert.equal(s, 200);
  assert.deepEqual(suspended.result, { status: "SUSPENDED", status_reason: "Abuse reports" });
  const [, hidden] = await get("/api/agents");
  assert.ok(!hidden.result.agents.some((a) => a.id === "flip1"));
  const [a2, active] = await moderate("flip1", "approve", { message: "Appeal upheld" });
  assert.equal(a2, 200);
  assert.equal(active.result.status, "ACTIVE");
  assert.equal(active.result.status_reason, "Appeal upheld");
  assert.ok(typeof active.result.api_key === "string" && active.result.api_key.length > 0);
  const [, back] = await get("/api/agents");
  assert.ok(back.result.agents.some((a) => a.id === "flip1"));
});

test("protocol: retiring an agent permanently removes it from listings", async () => {
  await post("/api/agents", { id: "gone1", role: "seller" });
  const [s, retired] = await moderate("gone1", "retire", { reason: "Operator request" });
  assert.equal(s, 200);
  assert.deepEqual(retired.result, { status: "RETIRED", status_reason: "Operator request" });
  const [, listed] = await get("/api/agents");
  assert.ok(!listed.result.agents.some((a) => a.id === "gone1"));
  const [, agents] = await aget("/api/admin/agents");
  assert.equal(agents.result.agents.find((a) => a.id === "gone1").status, "RETIRED");
});

test("protocol: illegal lifecycle transitions and bad input are rejected", async () => {
  // SUSPEND from PENDING is not on the table.
  const [s1, b1] = await moderate("t-ok", "suspend", { reason: "too soon" });
  assert.equal(s1, 409);
  assert.equal(b1.error.code, "ILLEGAL_TRANSITION");
  // REJECTED is terminal: no re-approval.
  const [s2, b2] = await moderate("rejected1", "approve", {});
  assert.equal(s2, 409);
  assert.equal(b2.error.code, "ILLEGAL_TRANSITION");
  // RETIRED is terminal: no re-approval.
  const [s3, b3] = await moderate("gone1", "approve", {});
  assert.equal(s3, 409);
  assert.equal(b3.error.code, "ILLEGAL_TRANSITION");
  // Missing reason on endpoints that require one.
  const [s4, b4] = await moderate("flip1", "suspend", {});
  assert.equal(s4, 400);
  assert.equal(b4.error.code, "INVALID_SCHEMA");
  const [s5, b5] = await moderate("flip1", "retire", { reason: "" });
  assert.equal(s5, 400);
  assert.equal(b5.error.code, "INVALID_SCHEMA");
  // Unknown agents 404 everywhere.
  const [s6, b6] = await moderate("ghost", "suspend", { reason: "x" });
  assert.equal(s6, 404);
  assert.equal(b6.error.code, "NO_SUCH_AGENT");
  const [ss, status] = await get("/api/agents/ghost/status");
  assert.equal(ss, 404);
  assert.equal(status.error.code, "NO_SUCH_AGENT");
});

test("protocol: the audit log records moderation with timestamps", async () => {
  const [, body] = await aget("/api/admin/audit");
  assert.equal(body.ok, true);
  const entries = body.result.audit.filter((e) => e.agentId === "flip1");
  assert.deepEqual(
    entries.map((e) => [e.action, e.from, e.to]),
    [["ACTIVE", "PENDING", "ACTIVE"], ["SUSPENDED", "ACTIVE", "SUSPENDED"], ["ACTIVE", "SUSPENDED", "ACTIVE"]],
  );
  for (const e of entries) {
    assert.equal(typeof e.at, "number");
    assert.ok(e.at > 0);
    assert.ok(e.reason === null || typeof e.reason === "string");
  }
  assert.ok(body.result.audit.length <= 100);
});

test("protocol: pages and console assets are served", async () => {
  const routes = [
    ["/", "Trust Layer for Agent Commerce"],
    ["/marketplace", "Marketplace"],
    ["/login", "Admin Secret"],
    ["/admin", "ADMIN CONSOLE"],
  ];
  for (const [route, marker] of routes) {
    const page = await fetch(url + route);
    assert.equal(page.status, 200, route);
    assert.match(page.headers.get("content-type"), /text\/html/, route);
    assert.match(await page.text(), new RegExp(marker), route);
  }
  const css = await fetch(url + "/style.css");
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /text\/css/);
  const js = await fetch(url + "/app.js");
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type"), /javascript/);
  const [s, b] = await get("/nope.png");
  assert.equal(s, 404);
  assert.equal(b.ok, false);
  assert.equal(b.error.code, "NOT_FOUND");
  // Images serve byte-identical: the Inspector fetches /demo-image.png and
  // a UTF-8 round-trip would corrupt the evidence payload.
  const png = await fetch(url + "/demo-image.png");
  assert.equal(png.status, 200);
  assert.match(png.headers.get("content-type"), /image\/png/);
  const expected = fs.readFileSync(new URL("../../public/demo-image.png", import.meta.url));
  assert.deepEqual(Buffer.from(await png.arrayBuffer()), expected);
});
