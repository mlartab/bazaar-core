import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { openStore } from "../../protocol/db.js";
import { createLedger, deposit, lock } from "../../src/ledger.js";
import { runInspection } from "../../protocol/inspector.js";
import {
  CAPABILITIES,
  isKnownCapability,
  inspectImageLocally,
  inspectAudioLocally,
} from "../../protocol/capabilities.js";
import { buildProfilePayload, syncProfile } from "../../protocol/supabase-sync.js";
import { validate } from "../../protocol/schemas.js";

// The sandbox sets HTTP(S)_PROXY for external traffic; loopback test
// traffic must bypass it or fetch tunnels 127.0.0.1 through the proxy.
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";

const closers = [];
after(async () => {
  for (const close of closers.splice(0)) {
    try {
      await close();
    } catch {
      // Already closed by the test itself.
    }
  }
});

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazaar-capabilities-"));
  closers.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, "store.db") };
}

// Minimal valid 1x1 PNG: signature + IHDR only. No CRC needed — the local
// checker sniffs magic bytes and IHDR dimensions, nothing more.
function tinyPng() {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(16);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4);
  ihdr.writeUInt32BE(1, 8);
  ihdr.writeUInt32BE(1, 12);
  return Buffer.concat([sig, ihdr]);
}

function tinyWav() {
  const head = Buffer.alloc(12);
  head.write("RIFF", 0);
  head.writeUInt32LE(4, 4);
  head.write("WAVE", 8);
  return head;
}

test("protocol: capability vocabulary is fixed and free-form values are unknown", () => {
  assert.deepEqual([...CAPABILITIES], ["image_gen", "speech_transcription", "video_gen", "text_gen"]);
  assert.equal(isKnownCapability("image_gen"), true);
  assert.equal(isKnownCapability("GPU rendering"), false);
  assert.equal(isKnownCapability("Video editing"), false);
  assert.equal(isKnownCapability(null), false);
  assert.equal(isKnownCapability(undefined), false);
});

test("protocol: local image check passes valid bytes and fails structural garbage", () => {
  const good = inspectImageLocally(tinyPng(), "a red square");
  assert.equal(good.verdict, "SETTLED");
  assert.equal(good.code, "STRUCTURAL_PASS");
  assert.equal(good.evidence.format, "png");
  assert.equal(good.evidence.width, 1);
  assert.equal(good.evidence.height, 1);
  assert.match(good.evidence.sha256, /^[0-9a-f]{64}$/);

  const garbage = inspectImageLocally(Buffer.from("not an image at all"), "a red square");
  assert.equal(garbage.verdict, "INCONCLUSIVE");
  assert.equal(garbage.code, "UNKNOWN_FORMAT");

  const empty = inspectImageLocally(Buffer.alloc(0), "a red square");
  assert.equal(empty.verdict, "REJECTED");
  assert.equal(empty.code, "EMPTY_BYTES");
});

test("protocol: local audio check passes headers and rejects malformed files", () => {
  const wav = inspectAudioLocally(tinyWav(), "hello world");
  assert.equal(wav.verdict, "SETTLED");
  assert.equal(wav.code, "STRUCTURAL_PASS");
  assert.equal(wav.evidence.format, "wav");

  const mp3 = inspectAudioLocally(Buffer.from([0xff, 0xfb, 0x90, 0x00]), "hello");
  assert.equal(mp3.verdict, "SETTLED");
  assert.equal(mp3.evidence.format, "mp3");

  const bad = inspectAudioLocally(Buffer.from("definitely not audio"), "hello");
  assert.equal(bad.verdict, "INCONCLUSIVE");
  assert.equal(bad.code, "UNKNOWN_FORMAT");

  const empty = inspectAudioLocally(Buffer.alloc(0), "hello");
  assert.equal(empty.verdict, "REJECTED");
  assert.equal(empty.code, "EMPTY_BYTES");
});

test("protocol: delivery schema accepts an optional capability override", () => {
  const base = { id: "d1", dealId: "d1", deliveryUrl: "https://example.com/w.png" };
  assert.deepEqual(validate("delivery", base), { ok: true });
  assert.deepEqual(validate("delivery", { ...base, capability: "image_gen" }), { ok: true });
  assert.equal(validate("delivery", { ...base, capability: "x".repeat(65) }).ok, false);
});

test("protocol: profile payload carries capability verbatim and never secrets", () => {
  const payload = buildProfilePayload({
    id: "s1",
    role: "seller",
    balance: 5,
    capability: "image_gen",
    status: "ACTIVE",
    title: "t",
    description: "d",
    price: 10,
    api_key: "SECRET-MUST-NOT-SYNC",
    status_reason: "nope",
  });
  assert.deepEqual(payload, {
    agent_id: "s1",
    role: "seller",
    balance: 5,
    capability: "image_gen",
    status: "ACTIVE",
    title: "t",
    description: "d",
    price: 10,
    category: null,
    service_type: "negotiation",
    min_price: null,
  });
  assert.equal(buildProfilePayload(null), null);
  assert.equal(buildProfilePayload({ role: "seller" }), null);
});

test("protocol: sync is a no-op envelope when Supabase is unconfigured", async () => {
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const result = await syncProfile({ id: "s1", capability: "image_gen" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "UNCONFIGURED");
  } finally {
    if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl;
    if (savedKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
  }
});

// Local fixture origin for router end-to-end: valid PNG, valid WAV, and
// structural garbage behind three paths. Loopback http is allowlisted by
// the inspector's guarded fetch.
async function startFixtures() {
  const server = http.createServer((req, res) => {
    if (req.url === "/valid.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(tinyPng());
    } else if (req.url === "/valid.wav") {
      res.writeHead(200, { "content-type": "audio/wav" });
      res.end(tinyWav());
    } else {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("not a deliverable");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  closers.push(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  return base;
}

function fundedLedger(buyer, seller, dealId, price) {
  const ledger = createLedger();
  assert.equal(deposit(ledger, buyer, price).ok, true);
  assert.equal(lock(ledger, buyer, dealId, price).ok, true);
  ledger.balances[seller] = 0;
  return ledger;
}

async function verifyingDeal(sellerCapability) {
  const { file } = tempDb();
  const store = openStore(file);
  closers.push(async () => store.close());
  store.saveAgent({ id: "cap-buyer", role: "buyer" });
  store.saveAgent({ id: "cap-seller", role: "seller", capability: sellerCapability, status: "ACTIVE" });
  store.saveDeal({ id: "cap-deal", state: "VERIFYING", buyer: "cap-buyer", seller: "cap-seller", price: 10 });
  return store;
}

test("protocol: router settles image_gen sellers on valid local bytes", async () => {
  const base = await startFixtures();
  const store = await verifyingDeal("image_gen");
  const result = await runInspection({
    store,
    ledger: fundedLedger("cap-buyer", "cap-seller", "cap-deal", 10),
    dealId: "cap-deal",
    deliveryUrl: `${base}/valid.png`,
    emit: () => {},
    log: console,
  });
  assert.equal(result.ok, true);
  assert.equal(result.to, "SETTLED");
  assert.equal(store.getDeal("cap-deal").state, "SETTLED");
});

test("protocol: router freezes on structural garbage instead of settling", async () => {
  const base = await startFixtures();
  const store = await verifyingDeal("image_gen");
  const events = [];
  const result = await runInspection({
    store,
    ledger: fundedLedger("cap-buyer", "cap-seller", "cap-deal", 10),
    dealId: "cap-deal",
    deliveryUrl: `${base}/garbage.txt`,
    emit: (e) => events.push(e),
    log: console,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "INCONCLUSIVE");
  assert.equal(store.getDeal("cap-deal").state, "VERIFYING");
});

test("protocol: router honors the per-delivery capability override", async () => {
  const base = await startFixtures();
  // Seller is registered free-form, but this delivery declares audio.
  const store = await verifyingDeal("Voice work");
  const result = await runInspection({
    store,
    ledger: fundedLedger("cap-buyer", "cap-seller", "cap-deal", 10),
    dealId: "cap-deal",
    deliveryUrl: `${base}/valid.wav`,
    capability: "speech_transcription",
    emit: () => {},
    log: console,
  });
  assert.equal(result.ok, true);
  assert.equal(result.to, "SETTLED");
});

test("protocol: video_gen freezes honestly until frame extraction lands", async () => {
  const base = await startFixtures();
  const store = await verifyingDeal("video_gen");
  const result = await runInspection({
    store,
    ledger: fundedLedger("cap-buyer", "cap-seller", "cap-deal", 10),
    dealId: "cap-deal",
    deliveryUrl: `${base}/valid.png`,
    emit: () => {},
    log: console,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "INCONCLUSIVE");
  assert.equal(store.getDeal("cap-deal").state, "VERIFYING");
});

test("protocol: free-form sellers keep today's default path byte-identical", async () => {
  const store = await verifyingDeal("GPU rendering");
  const result = await runInspection({
    store,
    ledger: fundedLedger("cap-buyer", "cap-seller", "cap-deal", 10),
    dealId: "cap-deal",
    deliveryUrl: "deliverable:abc",
    emit: () => {},
    log: console,
  });
  assert.equal(result.ok, true);
  assert.equal(result.to, "SETTLED");
});
