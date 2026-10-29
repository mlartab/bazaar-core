import test from "node:test";
import assert from "node:assert/strict";
import { SCHEMAS, validate } from "../../protocol/schemas.js";

function invalid(endpoint, request) {
  const result = validate(endpoint, request);
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_SCHEMA");
  assert.equal(typeof result.field, "string");
  assert.ok(result.field.length > 0);
  assert.equal(typeof result.message, "string");
  assert.ok(result.message.length > 0);
  return result;
}

test("protocol: schemas reject requests with missing fields", () => {
  assert.equal(invalid("registerAgent", { id: "a1" }).field, "role");
  assert.equal(invalid("registerAgent", { role: "buyer" }).field, "id");
  assert.equal(invalid("openDeal", { id: "d1", buyer: "a", seller: "b" }).field, "price");
  assert.equal(invalid("move", { key: "k1", kind: "OFFER", price: 50 }).field, "dealId");
  assert.equal(invalid("move", { dealId: "d1", kind: "OFFER", price: 50 }).field, "key");
  assert.equal(invalid("move", { dealId: "d1", key: "k1", price: 50 }).field, "kind");
  assert.equal(invalid("delivery", { dealId: "d1", deliveryUrl: "u1" }).field, "id");
  assert.equal(invalid("delivery", { id: "x1" }).field, "dealId");
  assert.equal(invalid("delivery", { id: "x1", dealId: "d1" }).field, "deliveryUrl");
});

test("protocol: schemas reject fields with the wrong type", () => {
  assert.equal(invalid("registerAgent", { id: 42, role: "buyer" }).field, "id");
  assert.equal(invalid("registerAgent", { id: "a1", role: null }).field, "role");
  assert.equal(invalid("openDeal", { id: "d1", buyer: "a", seller: "b", price: "50" }).field, "price");
  assert.equal(invalid("openDeal", { id: "d1", buyer: "a", seller: "b", price: 1.5 }).field, "price");
  assert.equal(invalid("openDeal", { id: "d1", buyer: "a", seller: "b", price: 0 }).field, "price");
  assert.equal(invalid("move", { dealId: "d1", key: "k1", kind: "OFFER", price: 2.5 }).field, "price");
  assert.equal(invalid("delivery", { id: "x1", dealId: ["d1"], deliveryUrl: "u1" }).field, "dealId");
  assert.equal(invalid("registerAgent", "buyer").field, "(request)");
  assert.equal(invalid("move", null).field, "(request)");
});

test("protocol: schemas reject unknown fields", () => {
  assert.equal(invalid("registerAgent", { id: "a1", role: "buyer", balance: 100 }).field, "balance");
  assert.equal(invalid("openDeal", { id: "d1", buyer: "a", seller: "b", price: 50, state: "AGREED" }).field, "state");
  assert.equal(invalid("move", { dealId: "d1", key: "k1", kind: "WALK", extra: 1 }).field, "extra");
  assert.equal(invalid("delivery", { id: "x1", dealId: "d1", deliveryUrl: "u1", price: 5 }).field, "price");
});

test("protocol: schemas reject out-of-set values", () => {
  assert.equal(invalid("registerAgent", { id: "a1", role: "admin" }).field, "role");
  assert.equal(invalid("move", { dealId: "d1", key: "k1", kind: "CHEAT", price: 50 }).field, "kind");
  assert.equal(invalid("move", { dealId: "d1", key: "k1", kind: "offer", price: 50 }).field, "kind");
  // The verdict is server-side: any client-supplied status is unknown.
  assert.equal(invalid("delivery", { id: "x1", dealId: "d1", deliveryUrl: "u1", status: "DELIVERED" }).field, "status");
  assert.deepEqual(Object.keys(SCHEMAS).sort(), ["delivery", "moderationNote", "move", "openDeal", "pay", "registerAgent", "reviewNote"]);
  assert.deepEqual(validate("reviewNote", {}), { ok: true });
  assert.deepEqual(validate("reviewNote", { message: "ok" }), { ok: true });
  assert.deepEqual(validate("moderationNote", { reason: "spam" }), { ok: true });
  assert.equal(validate("moderationNote", {}).code, "INVALID_SCHEMA");
  assert.equal(validate("moderationNote", { reason: "" }).code, "INVALID_SCHEMA");
  assert.equal(validate("moderationNote", { reason: 42 }).code, "INVALID_SCHEMA");
});

test("protocol: schemas reject a WALK move carrying a price", () => {
  const result = invalid("move", { dealId: "d1", key: "k1", kind: "WALK", price: 50 });
  assert.equal(result.field, "price");
});

test("protocol: schemas reject an OFFER without a price", () => {
  assert.equal(invalid("move", { dealId: "d1", key: "k1", kind: "OFFER" }).field, "price");
  assert.equal(invalid("move", { dealId: "d1", key: "k1", kind: "ACCEPT" }).field, "price");
});

test("protocol: schemas accept a valid request for each endpoint", () => {
  assert.deepEqual(validate("registerAgent", { id: "a1", role: "buyer" }), { ok: true });
  assert.deepEqual(validate("registerAgent", { id: "a2", role: "seller" }), { ok: true });
  assert.deepEqual(validate("openDeal", { id: "d1", buyer: "a1", seller: "a2", price: 50 }), { ok: true });
  assert.deepEqual(validate("move", { dealId: "d1", key: "k1", kind: "OFFER", price: 50 }), { ok: true });
  assert.deepEqual(validate("move", { dealId: "d1", key: "k2", kind: "ACCEPT", price: 50 }), { ok: true });
  assert.deepEqual(validate("move", { dealId: "d1", key: "k3", kind: "WALK" }), { ok: true });
  assert.deepEqual(validate("delivery", { id: "x1", dealId: "d1", deliveryUrl: "u1" }), { ok: true });
  assert.deepEqual(validate("pay", {}), { ok: true });
});

test("protocol: schemas reject any field on pay", () => {
  assert.equal(invalid("pay", { fee: 1 }).field, "fee");
});

test("protocol: schemas reject over-long identifiers", () => {
  const long = "x".repeat(129);
  assert.equal(invalid("openDeal", { id: long, buyer: "b", seller: "s", price: 1 }).field, "id");
  assert.equal(invalid("move", { dealId: "d", key: long, kind: "WALK" }).field, "key");
  assert.equal(invalid("moderationNote", { reason: long }).field, "reason");
  // 128 is the boundary: exactly at the limit still passes.
  assert.deepEqual(validate("openDeal", { id: "x".repeat(128), buyer: "b", seller: "s", price: 1 }), { ok: true });
});
