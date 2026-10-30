import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { startServer, buildVerdict } from "../../protocol/server.js";
import { negotiationWindowMs, inspectionTimeoutMs, deliverySlaBounds } from "../../protocol/config.js";

// Loopback must bypass the sandbox proxy.
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";
process.env.ADMIN_SECRET = "test-agentloop-secret";

let url;
let stop;
let dir;
let n = 0;

const freshKey = () => `loop-${(n += 1)}`;

async function post(p, body, { key, agentKey } = {}) {
  const headers = { "content-type": "application/json", "idempotency-key": key ?? freshKey() };
  if (agentKey !== undefined) headers["x-agent-key"] = agentKey;
  const res = await fetch(url + p, { method: "POST", headers, body: JSON.stringify(body) });
  return [res.status, await res.json()];
}

async function get(p, agentKey) {
  const headers = agentKey === undefined ? {} : { "x-agent-key": agentKey };
  const res = await fetch(url + p, { headers });
  return [res.status, await res.json()];
}

async function aget(p, body) {
  const res = await fetch(url + p, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": freshKey(), authorization: `Bearer ${process.env.ADMIN_SECRET}` },
    body: JSON.stringify(body ?? {}),
  });
  return [res.status, await res.json()];
}

async function apatch(p, body) {
  const res = await fetch(url + p, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.ADMIN_SECRET}` },
    body: JSON.stringify(body ?? {}),
  });
  return [res.status, await res.json()];
}

function assertErr(body, code) {
  assert.equal(body.ok, false);
  assert.equal(body.error.code, code);
}

let aKey;
let bKey;
let cKey;

async function register(id, role, extra = {}) {
  const [status, body] = await post("/api/agents", { id, role, ...extra });
  assert.equal(status, 200);
  return body.result.api_key;
}

// Raw SSE client: collects data frames until `want` matches or timeout.
function openStream(agentId, key, { since } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Accept: "text/event-stream" };
    if (key !== undefined) headers["x-agent-key"] = key;
    if (since !== undefined) headers["Last-Event-ID"] = String(since);
    const target = new URL(`/api/agents/${agentId}/events/stream`, url);
    const req = http.get(target, { headers }, (res) => {
      const frames = [];
      let buf = "";
      let closed = false;
      res.on("close", () => {
        closed = true;
      });
      res.on("data", (chunk) => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const idLine = raw.split("\n").find((l) => l.startsWith("id: "));
          const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
          if (dataLine !== undefined) {
            frames.push({ id: idLine === undefined ? null : Number(idLine.slice(4)), data: JSON.parse(dataLine.slice(6)) });
          }
        }
      });
      resolve({ status: res.statusCode, frames, close: () => res.destroy(), isClosed: () => closed });
    });
    req.on("error", reject);
  });
}

async function waitFor(frames, pred, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    const hit = frames.find(pred);
    if (hit !== undefined) return hit;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for stream frame");
    await new Promise((r) => setTimeout(r, 50));
  }
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazaar-loop-"));
  const started = await startServer({ dbPath: path.join(dir, "store.db"), port: 0 });
  url = started.url;
  stop = started.close;
  aKey = await register("loop-a", "buyer");
  bKey = await register("loop-b", "seller");
  cKey = await register("loop-c", "buyer");
});

after(async () => {
  await stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("protocol: agent streams require the owner's key", async () => {
  const keyless = await openStream("loop-a", undefined);
  assert.equal(keyless.status, 401);
  keyless.close();
  const wrong = await openStream("loop-a", cKey);
  assert.equal(wrong.status, 403);
  wrong.close();
});

test("protocol: agent streams only carry the agent's own deals and resume", async () => {
  const s = await openStream("loop-a", aKey);
  assert.equal(s.status, 200);
  // Another pair's deal must never appear on A's feed.
  const [, od] = await post("/api/deals", { id: "loop-other", buyer: "loop-c", seller: "loop-b", price: 30 }, { agentKey: cKey });
  assert.equal(od.ok, true);
  // A's own deal must arrive with an id frame.
  const [, mine] = await post("/api/deals", { id: "loop-mine", buyer: "loop-a", seller: "loop-b", price: 40 }, { agentKey: aKey });
  assert.equal(mine.ok, true);
  const hit = await waitFor(s.frames, (f) => f.data.dealId === "loop-mine");
  assert.equal(typeof hit.id, "number");
  assert.equal(s.frames.some((f) => f.data.dealId === "loop-other"), false);
  // Reconnect with Last-Event-ID replays the missed frame.
  s.close();
  const s2 = await openStream("loop-a", aKey, { since: hit.id - 1 });
  const replayed = await waitFor(s2.frames, (f) => f.data.dealId === "loop-mine");
  assert.equal(replayed.id, hit.id);
  s2.close();
});

async function assertStreamClosed(stream, label) {
  const start = Date.now();
  while (!stream.isClosed() && Date.now() - start < 3000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(stream.isClosed(), true, `${label}: server should have ended the stream`);
}

test("protocol: streams are capped and die on rotation and moderation", async () => {
  const s1 = await openStream("loop-a", aKey);
  const s2 = await openStream("loop-a", aKey);
  assert.equal(s1.status, 200);
  assert.equal(s2.status, 200);
  const s3 = await openStream("loop-a", aKey);
  assert.equal(s3.status, 429);
  s3.close();
  s2.close();
  // Rotation closes the remaining stream; the rotated key stays usable.
  const [rs, rb] = await post("/api/agents/loop-a/rotate-key", {}, { key: "loop-rot-1", agentKey: aKey });
  assert.equal(rs, 200);
  await assertStreamClosed(s1, "rotate");
  aKey = rb.result.api_key;
  // Suspension closes streams; retirement does too (same hook). Suspension
  // needs an ACTIVE agent, so approve the fresh PENDING row first.
  const aKey2 = await register("loop-a2", "buyer");
  const [ap] = await aget("/api/admin/agents/loop-a2/approve", {});
  assert.equal(ap, 200);
  const t1 = await openStream("loop-a2", aKey2);
  const [ss] = await aget("/api/admin/agents/loop-a2/suspend", { reason: "loop test" });
  assert.equal(ss, 200);
  await assertStreamClosed(t1, "suspend");
  const t2 = await openStream("loop-a2", aKey2);
  const [rst] = await aget("/api/admin/agents/loop-a2/retire", { reason: "loop test" });
  assert.equal(rst, 200);
  await assertStreamClosed(t2, "retire");
});

test("protocol: listing SLA is snapshotted onto the deal and honored at pay", async () => {
  const sellerKey = await register("loop-sla", "seller", {
    title: "SLA Seller Listing", description: "A sufficiently long description for the SLA seller.", price: 50, category: "image_gen",
    delivery_sla_seconds: 90,
  });
  const [, open] = await post("/api/deals", { id: "loop-sla-1", buyer: "loop-c", seller: "loop-sla", price: 50 }, { agentKey: cKey });
  assert.equal(open.ok, true);
  await post(`/api/deals/loop-sla-1/moves`, { key: "sla-o", kind: "OFFER", price: 50 }, { agentKey: cKey });
  await post(`/api/deals/loop-sla-1/moves`, { key: "sla-a", kind: "ACCEPT", price: 50 }, { agentKey: sellerKey });
  const before = Date.now();
  const [ps] = await post(`/api/deals/loop-sla-1/pay`, {}, { agentKey: cKey });
  assert.equal(ps, 200);
  const [, detail] = await get("/api/deals/loop-sla-1", cKey);
  const stamp = Date.parse(detail.result.verdict.timestamps.delivery_expires);
  assert.ok(Math.abs(stamp - (before + 90 * 1000)) < 10000, `delivery_expires ≈ pay+90s, got ${detail.result.verdict.timestamps.delivery_expires}`);
  // Editing the listing afterwards does not move the running deal, but new
  // deals snapshot the new value.
  const [patchS] = await apatch("/api/admin/agents/loop-sla", { delivery_sla_seconds: 3600 });
  assert.equal(patchS, 200);
  const [, detail1b] = await get("/api/deals/loop-sla-1", cKey);
  const stamp1b = Date.parse(detail1b.result.verdict.timestamps.delivery_expires);
  assert.ok(Math.abs(stamp1b - stamp) < 5000, "running deal keeps its snapshot");
  const [, open2] = await post("/api/deals", { id: "loop-sla-2", buyer: "loop-c", seller: "loop-sla", price: 50 }, { agentKey: cKey });
  assert.equal(open2.ok, true);
  await post(`/api/deals/loop-sla-2/moves`, { key: "sla2-o", kind: "OFFER", price: 50 }, { agentKey: cKey });
  await post(`/api/deals/loop-sla-2/moves`, { key: "sla2-a", kind: "ACCEPT", price: 50 }, { agentKey: sellerKey });
  const before2 = Date.now();
  const [ps2] = await post(`/api/deals/loop-sla-2/pay`, {}, { agentKey: cKey });
  assert.equal(ps2, 200);
  const [, detail2] = await get("/api/deals/loop-sla-2", cKey);
  const stamp2 = Date.parse(detail2.result.verdict.timestamps.delivery_expires);
  assert.ok(Math.abs(stamp2 - (before2 + 3600 * 1000)) < 10000, `new deal uses 3600s SLA, got ${detail2.result.verdict.timestamps.delivery_expires}`);
  // Out-of-env SLA is a schema-shaped 400.
  process.env.DELIVERY_SLA_MIN_SECONDS = "120";
  const [bad] = await post("/api/agents", { id: "loop-sla-bad", role: "seller", delivery_sla_seconds: 100 });
  assert.equal(bad, 400);
  delete process.env.DELIVERY_SLA_MIN_SECONDS;
  assert.equal(deliverySlaBounds().min, 60);
});

test("protocol: verdict block reports ISO-8601 states on live deals", async () => {
  const [, opened] = await get("/api/deals/loop-mine", aKey);
  assert.equal(opened.result.verdict.status, "PENDING");
  assert.equal(opened.result.verdict.verdict_reason, "Deal in progress.");
  assert.match(opened.result.verdict.timestamps.created, /^\d{4}-\d{2}-\d{2}T/);
  await post(`/api/deals/loop-mine/moves`, { key: "v-o", kind: "OFFER", price: 40 }, { agentKey: aKey });
  await post(`/api/deals/loop-mine/moves`, { key: "v-a", kind: "ACCEPT", price: 40 }, { agentKey: bKey });
  await post(`/api/deals/loop-mine/pay`, {}, { agentKey: aKey });
  await post(`/api/deals/loop-mine/delivery`, { id: "v-d1", deliveryUrl: "https://video.example.com/v.mp4", capability: "video_gen" }, { agentKey: bKey });
  const [, frozen] = await get("/api/deals/loop-mine", aKey);
  assert.equal(frozen.result.deal.state, "VERIFYING");
  assert.equal(frozen.result.verdict.status, "FROZEN");
  assert.match(frozen.result.verdict.timestamps.delivery_expires, /^\d{4}-\d{2}-\d{2}T/);
});

test("protocol: verdict mapping covers terminal states", async () => {
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const settled = buildVerdict({ state: "SETTLED" }, { close_reason: null, created_at: 1, updated_at: 2, expires_at: 3, delivery_expires_at: 4 });
  assert.equal(settled.status, "SETTLED");
  assert.match(settled.timestamps.created, iso);
  const expired = buildVerdict({ state: "REJECTED" }, { close_reason: "DELIVERY_TIMEOUT", created_at: 1, updated_at: 2, expires_at: null, delivery_expires_at: 4 });
  assert.equal(expired.status, "EXPIRED");
  assert.match(expired.verdict_reason, /refund/);
  const rejected = buildVerdict({ state: "REJECTED" }, { close_reason: null, created_at: 1, updated_at: 2, expires_at: null, delivery_expires_at: null });
  assert.equal(rejected.status, "REJECTED");
  assert.equal(rejected.timestamps.delivery_expires, null);
  const pending = buildVerdict({ state: "AGREED" }, { close_reason: null, created_at: 1, updated_at: 2, expires_at: 3, delivery_expires_at: null });
  assert.equal(pending.status, "PENDING");
});

test("protocol: openDeal issues a namespaced id when omitted", async () => {
  const [s, b] = await post("/api/deals", { buyer: "loop-a", seller: "loop-b", price: 10 }, { agentKey: aKey, key: "noid-1" });
  assert.equal(s, 200);
  assert.match(b.result.deal.id, /^deal-[0-9a-f]{8}$/);
  // Replay returns the same issued id.
  const [rs, rb] = await post("/api/deals", { buyer: "loop-a", seller: "loop-b", price: 10 }, { agentKey: aKey, key: "noid-1" });
  assert.equal(rs, 200);
  assert.equal(rb.result.deal.id, b.result.deal.id);
  // Missing buyer is still a 400.
  const [bs, bb] = await post("/api/deals", { seller: "loop-b", price: 10 }, { agentKey: aKey });
  assert.equal(bs, 400);
  assert.equal(bb.error.code, "INVALID_SCHEMA");
});

test("protocol: timing envs parse with safe defaults", async () => {
  assert.equal(negotiationWindowMs(), 60000);
  assert.equal(inspectionTimeoutMs(), 300000);
  assert.deepEqual(deliverySlaBounds(), { min: 60, max: 86400, def: 300 });
  assert.equal(negotiationWindowMs({ NEGOTIATION_WINDOW_MS: "5" }), 5);
  assert.equal(inspectionTimeoutMs({ INSPECTION_TIMEOUT_MS: "0" }), 300000);
});

test("protocol: negotiation window env flows through createApp into sweeps", async () => {
  process.env.NEGOTIATION_WINDOW_MS = "200";
  process.env.DEMO_SAFE = "true";
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "bazaar-loop-neg-"));
  const started = await startServer({ dbPath: path.join(dir2, "store.db"), port: 0 });
  try {
    const post2 = async (p, body, key) => {
      const h = { "content-type": "application/json", "idempotency-key": freshKey() };
      if (key) h["x-agent-key"] = key;
      const r = await fetch(started.url + p, { method: "POST", headers: h, body: JSON.stringify(body) });
      return [r.status, await r.json()];
    };
    const [, reg] = await post2("/api/agents", { id: "neg-a", role: "buyer" });
    const [, regB] = await post2("/api/agents", { id: "neg-b", role: "seller" });
    const [, opened] = await post2("/api/deals", { id: "neg-d", buyer: "neg-a", seller: "neg-b", price: 10 }, reg.result.api_key);
    assert.equal(opened.ok, true);
    await new Promise((r) => setTimeout(r, 400));
    await fetch(started.url + "/api/admin/demo/sweep", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": freshKey(), authorization: `Bearer ${process.env.ADMIN_SECRET}` },
      body: "{}",
    });
    const res = await fetch(`${started.url}/api/deals/neg-d`, { headers: { "x-agent-key": reg.result.api_key } });
    const found = await res.json();
    assert.equal(found.result.deal.state, "REJECTED");
    assert.equal(found.result.verdict.status, "EXPIRED");
  } finally {
    await started.close();
    fs.rmSync(dir2, { recursive: true, force: true });
    delete process.env.NEGOTIATION_WINDOW_MS;
    delete process.env.DEMO_SAFE;
  }
});

test("protocol: close() ends agent and admin streams so shutdown never hangs", async () => {
  // Railway sends SIGTERM, start.js awaits close(): with any live SSE feed
  // server.close() alone would wait forever, so close() must end them all.
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "bazaar-loop-shutdown-"));
  const started = await startServer({ dbPath: path.join(dir3, "store.db"), port: 0 });
  try {
    const regRes = await fetch(`${started.url}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": freshKey() },
      body: JSON.stringify({ id: "shut-a", role: "buyer" }),
    });
    assert.equal(regRes.status, 200);
    const regBody = await regRes.json();
    const openRaw = (targetPath, headers) => new Promise((resolve, reject) => {
      const req = http.get(new URL(targetPath, started.url), { headers }, (res) => {
        let closed = false;
        res.on("data", () => {});
        res.on("close", () => { closed = true; });
        resolve({ status: res.statusCode, isClosed: () => closed });
      });
      req.on("error", reject);
    });
    const agent = await openRaw("/api/agents/shut-a/events/stream", { Accept: "text/event-stream", "x-agent-key": regBody.result.api_key });
    assert.equal(agent.status, 200);
    const admin = await openRaw(`/api/admin/events/stream?token=${process.env.ADMIN_SECRET}`, { Accept: "text/event-stream" });
    assert.equal(admin.status, 200);
    const shut = await Promise.race([
      started.close().then(() => true),
      new Promise((r) => setTimeout(() => r(false), 5000)),
    ]);
    assert.equal(shut, true, "close() must resolve with live SSE streams open");
    for (const [stream, label] of [[agent, "agent"], [admin, "admin"]]) {
      const start = Date.now();
      while (!stream.isClosed() && Date.now() - start < 3000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(stream.isClosed(), true, `${label} stream ended on shutdown`);
    }
  } finally {
    fs.rmSync(dir3, { recursive: true, force: true });
  }
});
