import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "../../protocol/db.js";
import { DELIVERY_TIMEOUT_MS, INSPECTION_TIMEOUT_MS } from "../../protocol/config.js";
import { createSessionManager } from "../../protocol/session-manager.js";
import { createLedger, deposit, lock } from "../../src/ledger.js";

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazaar-sessions-"));
  return { dir, file: path.join(dir, "store.db") };
}

function cleanup(store, { dir }) {
  try {
    store?.close?.();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A fixed clock: expiry is about the stamp comparison, never about waiting.
const NOW = 1_700_000_000_000;

test("protocol: sessions expire a stale NEGOTIATING deal without touching balances", () => {
  const tmp = tempFile();
  const store = openStore(tmp.file);
  try {
    const ledger = createLedger();
    assert.equal(deposit(ledger, "buyer", 100).ok, true);
    store.saveDeal({ id: "d-stale", state: "NEGOTIATING", buyer: "buyer", seller: "seller", price: 50, expires_at: NOW - 1 });
    const sessions = createSessionManager({ store, ledger, now: () => NOW });
    const outcomes = sessions.sweepOnce();
    assert.deepEqual(outcomes, [{ id: "d-stale", from: "NEGOTIATING", to: "REJECTED", refunded: false }]);
    const deal = store.listDeals().find((row) => row.id === "d-stale");
    assert.equal(deal.state, "REJECTED");
    assert.equal(deal.close_reason, "EXPIRED_TIMEOUT");
    // The opening deposit was buyer balance, never locked: the sandbox
    // faucet stays where it is, no clawback.
    assert.equal(ledger.balances.buyer, 100);
    assert.equal(Object.keys(ledger.locks).length, 0);
  } finally {
    cleanup(store, tmp);
  }
});

test("protocol: sessions expire a stale AGREED deal and refund the lock", () => {
  const tmp = tempFile();
  const store = openStore(tmp.file);
  try {
    const ledger = createLedger();
    assert.equal(deposit(ledger, "buyer", 100).ok, true);
    assert.equal(lock(ledger, "buyer", "d-agreed", 40).ok, true);
    store.saveDeal({ id: "d-agreed", state: "AGREED", buyer: "buyer", seller: "seller", price: 40, expires_at: NOW - 1 });
    const sessions = createSessionManager({ store, ledger, now: () => NOW });
    const outcomes = sessions.sweepOnce();
    assert.deepEqual(outcomes, [{ id: "d-agreed", from: "AGREED", to: "REJECTED", refunded: true }]);
    const deal = store.listDeals().find((row) => row.id === "d-agreed");
    assert.equal(deal.state, "REJECTED");
    assert.equal(deal.close_reason, "EXPIRED_TIMEOUT");
    assert.equal(ledger.locks["d-agreed"], undefined);
    assert.equal(ledger.balances.buyer, 100);
  } finally {
    cleanup(store, tmp);
  }
});

test("protocol: sessions leave fresh and terminal deals alone", () => {
  const tmp = tempFile();
  const store = openStore(tmp.file);
  try {
    const ledger = createLedger();
    store.saveDeal({ id: "d-fresh", state: "NEGOTIATING", buyer: "b", seller: "s", price: 10, expires_at: NOW + 60_000 });
    store.saveDeal({ id: "d-settled", state: "SETTLED", buyer: "b", seller: "s", price: 10, expires_at: NOW - 1_000 });
    store.saveDeal({ id: "d-legacy", state: "NEGOTIATING", buyer: "b", seller: "s", price: 10, expires_at: null });
    const sessions = createSessionManager({ store, ledger, now: () => NOW });
    assert.deepEqual(sessions.sweepOnce(), []);
    const states = Object.fromEntries(store.listDeals().map((row) => [row.id, row.state]));
    assert.deepEqual(states, { "d-fresh": "NEGOTIATING", "d-settled": "SETTLED", "d-legacy": "NEGOTIATING" });
  } finally {
    cleanup(store, tmp);
  }
});

test("protocol: sessions expire a stale ESCROW_LOCKED deal and refund the lock", () => {
  const tmp = tempFile();
  const store = openStore(tmp.file);
  try {
    const ledger = createLedger();
    assert.equal(deposit(ledger, "buyer", 100).ok, true);
    assert.equal(lock(ledger, "buyer", "d-escrow", 40).ok, true);
    store.saveDeal({ id: "d-escrow", state: "ESCROW_LOCKED", buyer: "buyer", seller: "seller", price: 40, delivery_expires_at: NOW - 1 });
    const sessions = createSessionManager({ store, ledger, now: () => NOW });
    const outcomes = sessions.sweepDeliveries();
    assert.deepEqual(outcomes, [{ id: "d-escrow", from: "ESCROW_LOCKED", to: "REJECTED", refunded: true }]);
    const deal = store.listDeals().find((row) => row.id === "d-escrow");
    assert.equal(deal.state, "REJECTED");
    assert.equal(deal.close_reason, "DELIVERY_TIMEOUT");
    assert.equal(ledger.locks["d-escrow"], undefined);
    assert.equal(ledger.balances.buyer, 100);
    // The session sweep ignores post-AGREED states: no double jeopardy.
    assert.deepEqual(sessions.sweepOnce(), []);
  } finally {
    cleanup(store, tmp);
  }
});

test("protocol: sessions expire an unstamped ESCROW_LOCKED deal via created_at", () => {
  const tmp = tempFile();
  const store = openStore(tmp.file);
  try {
    const ledger = createLedger();
    assert.equal(deposit(ledger, "buyer", 100).ok, true);
    assert.equal(lock(ledger, "buyer", "d-old-escrow", 40).ok, true);
    store.saveDeal({ id: "d-old-escrow", state: "ESCROW_LOCKED", buyer: "buyer", seller: "seller", price: 40 });
    // created_at is unix seconds: 1 means 1970, older than any timeout.
    const raw = new DatabaseSync(tmp.file);
    try {
      raw.exec("UPDATE deals SET created_at = 1 WHERE id = 'd-old-escrow'");
    } finally {
      raw.close();
    }
    const sessions = createSessionManager({ store, ledger, now: () => NOW });
    const outcomes = sessions.sweepDeliveries();
    assert.deepEqual(outcomes, [{ id: "d-old-escrow", from: "ESCROW_LOCKED", to: "REJECTED", refunded: true }]);
    assert.equal(store.listDeals().find((row) => row.id === "d-old-escrow").close_reason, "DELIVERY_TIMEOUT");
    assert.equal(ledger.balances.buyer, 100);
  } finally {
    cleanup(store, tmp);
  }
});

test("protocol: sessions leave a fresh escrow alone", () => {
  const tmp = tempFile();
  const store = openStore(tmp.file);
  try {
    const ledger = createLedger();
    assert.equal(deposit(ledger, "buyer", 100).ok, true);
    assert.equal(lock(ledger, "buyer", "d-fresh-escrow", 40).ok, true);
    store.saveDeal({ id: "d-fresh-escrow", state: "ESCROW_LOCKED", buyer: "buyer", seller: "seller", price: 40, delivery_expires_at: NOW + DELIVERY_TIMEOUT_MS });
    const sessions = createSessionManager({ store, ledger, now: () => NOW });
    assert.deepEqual(sessions.sweepDeliveries(), []);
    assert.equal(store.listDeals().find((row) => row.id === "d-fresh-escrow").state, "ESCROW_LOCKED");
  } finally {
    cleanup(store, tmp);
  }
});

test("protocol: sessions unfreeze a stale VERIFYING deal and refund the lock", () => {
  const tmp = tempFile();
  const store = openStore(tmp.file);
  try {
    const ledger = createLedger();
    assert.equal(deposit(ledger, "buyer", 100).ok, true);
    assert.equal(lock(ledger, "buyer", "d-frozen", 40).ok, true);
    store.saveDeal({ id: "d-frozen", state: "VERIFYING", buyer: "buyer", seller: "seller", price: 40 });
    const raw = new DatabaseSync(tmp.file);
    try {
      raw.exec(`UPDATE deals SET updated_at = ${NOW - INSPECTION_TIMEOUT_MS - 1} WHERE id = 'd-frozen'`);
    } finally {
      raw.close();
    }
    const sessions = createSessionManager({ store, ledger, now: () => NOW });
    const outcomes = sessions.sweepInspections();
    assert.deepEqual(outcomes, [{ id: "d-frozen", from: "VERIFYING", to: "REJECTED", refunded: true, reason: "INSPECTION_TIMEOUT" }]);
    const deal = store.listDeals().find((row) => row.id === "d-frozen");
    assert.equal(deal.state, "REJECTED");
    assert.equal(deal.close_reason, "INSPECTION_TIMEOUT");
    assert.equal(ledger.locks["d-frozen"], undefined);
    assert.equal(ledger.balances.buyer, 100);
  } finally {
    cleanup(store, tmp);
  }
});

test("protocol: sessions leave a fresh VERIFYING deal alone", () => {
  const tmp = tempFile();
  const store = openStore(tmp.file);
  try {
    const ledger = createLedger();
    assert.equal(deposit(ledger, "buyer", 100).ok, true);
    assert.equal(lock(ledger, "buyer", "d-warm", 40).ok, true);
    store.saveDeal({ id: "d-warm", state: "VERIFYING", buyer: "buyer", seller: "seller", price: 40 });
    const raw = new DatabaseSync(tmp.file);
    try {
      raw.exec(`UPDATE deals SET updated_at = ${NOW - 1000} WHERE id = 'd-warm'`);
    } finally {
      raw.close();
    }
    const sessions = createSessionManager({ store, ledger, now: () => NOW });
    assert.deepEqual(sessions.sweepInspections(), []);
    assert.equal(store.listDeals().find((row) => row.id === "d-warm").state, "VERIFYING");
    assert.equal(ledger.locks["d-warm"].amount, 40);
  } finally {
    cleanup(store, tmp);
  }
});

test("protocol: sessions keep a lockless VERIFYING deal frozen on sweep failure", () => {
  const tmp = tempFile();
  const store = openStore(tmp.file);
  try {
    const ledger = createLedger();
    store.saveDeal({ id: "d-nolock", state: "VERIFYING", buyer: "buyer", seller: "seller", price: 40 });
    const raw = new DatabaseSync(tmp.file);
    try {
      raw.exec(`UPDATE deals SET updated_at = ${NOW - INSPECTION_TIMEOUT_MS - 1} WHERE id = 'd-nolock'`);
    } finally {
      raw.close();
    }
    const sessions = createSessionManager({ store, ledger, now: () => NOW });
    const outcomes = sessions.sweepInspections();
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].to, null);
    assert.match(outcomes[0].error ?? "", /lock to refund|no lock/i);
    assert.equal(store.listDeals().find((row) => row.id === "d-nolock").state, "VERIFYING");
  } finally {
    cleanup(store, tmp);
  }
});

test("protocol: a legacy database migrates expiry columns with NULL backfill", () => {
  const tmp = tempFile();
  // Hand-build a pre-timeout file: deals predate expires_at/close_reason.
  const legacy = new DatabaseSync(tmp.file);
  try {
    legacy.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, role TEXT, balance INTEGER)`);
    legacy.exec(`CREATE TABLE deals (id TEXT PRIMARY KEY, state TEXT NOT NULL, buyer TEXT, seller TEXT, price INTEGER, created_at INTEGER)`);
    legacy.exec(`CREATE TABLE moves (id TEXT PRIMARY KEY, deal_id TEXT, key TEXT, kind TEXT, price INTEGER)`);
    legacy.exec(`CREATE TABLE deliveries (id TEXT PRIMARY KEY, deal_id TEXT, status TEXT)`);
    legacy.exec(`INSERT INTO deals (id, state, buyer, seller, price) VALUES ('d-old', 'NEGOTIATING', 'b', 's', 25)`);
  } finally {
    legacy.close();
  }
  const store = openStore(tmp.file);
  try {
    const row = store.listDeals().find((d) => d.id === "d-old");
    assert.equal(row.state, "NEGOTIATING");
    assert.equal(row.expires_at, null);
    assert.equal(row.close_reason, null);
    // New deals on the migrated file carry stamps like any fresh store.
    store.saveDeal({ id: "d-new", state: "NEGOTIATING", buyer: "b", seller: "s", price: 5, expires_at: NOW + 60_000 });
    assert.equal(store.listDeals().find((d) => d.id === "d-new").expires_at, NOW + 60_000);
  } finally {
    cleanup(store, tmp);
  }
});
