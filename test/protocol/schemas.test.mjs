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
  assert.deepEqual(Object.keys(SCHEMAS).sort(), ["delivery", "linkEmail", "moderationNote", "move", "openDeal", "patchAgent", "pay", "registerAgent", "reviewNote"]);
  assert.deepEqual(validate("reviewNote", {}), { ok: true });
  assert.deepEqual(validate("reviewNote", { message: "ok" }), { ok: true });
  assert.deepEqual(validate("moderationNote", { reason: "spam" }), { ok: true });
  assert.equal(validate("moderationNote", {}).code, "INVALID_SCHEMA");
  assert.equal(validate("moderationNote", { reason: "" }).code, "INVALID_SCHEMA");
  assert.equal(validate("moderationNote", { reason: 42 }).code, "INVALID_SCHEMA");
  assert.deepEqual(validate("linkEmail", { email: "a@example.com", owner_email: "o@example.com" }), { ok: true });
  assert.equal(validate("linkEmail", { email: "a@example.com" }).code, "INVALID_SCHEMA");
  assert.equal(validate("linkEmail", { email: "", owner_email: "o@example.com" }).code, "INVALID_SCHEMA");
  assert.equal(validate("linkEmail", { email: "a@example.com", owner_email: "o@example.com", api_key: "x" }).field, "api_key");
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

test("protocol: category is optional on registration but strict when present", () => {
  assert.deepEqual(validate("registerAgent", { id: "c1", role: "seller" }), { ok: true });
  assert.deepEqual(
    validate("registerAgent", { id: "c2", role: "seller", category: "image_gen" }),
    { ok: true },
  );
  assert.equal(validate("registerAgent", { id: "c3", role: "seller", category: "podcasts" }).code, "INVALID_SCHEMA");
});

test("protocol: registerAgent enforces storefront listing bounds", () => {
  const base = { id: "s1", role: "seller" };
  // Short title / short description fail with INVALID_SCHEMA.
  assert.equal(invalid("registerAgent", { ...base, title: "Hi" }).field, "title");
  assert.equal(invalid("registerAgent", { ...base, description: "too short" }).field, "description");
  // Over-long title / description fail.
  assert.equal(invalid("registerAgent", { ...base, title: "x".repeat(61) }).field, "title");
  assert.equal(invalid("registerAgent", { ...base, description: "x".repeat(251) }).field, "description");
  // Zero and six-figure-plus prices fail.
  assert.equal(invalid("registerAgent", { ...base, price: 0 }).field, "price");
  assert.equal(invalid("registerAgent", { ...base, price: 100001 }).field, "price");
  // Exact boundaries pass.
  assert.deepEqual(validate("registerAgent", { ...base, title: "x".repeat(5), description: "x".repeat(20), price: 1 }), { ok: true });
  assert.deepEqual(validate("registerAgent", { ...base, title: "x".repeat(60), description: "x".repeat(250), price: 100000 }), { ok: true });
});

test("protocol: patchAgent accepts partial edits and rejects unknowns", () => {
  assert.deepEqual(validate("patchAgent", { title: "New Title" }), { ok: true });
  assert.deepEqual(validate("patchAgent", { price: 1, category: "data" }), { ok: true });
  assert.equal(validate("patchAgent", { title: "Hi" }).code, "INVALID_SCHEMA");
  assert.equal(validate("patchAgent", { title: "x".repeat(61) }).code, "INVALID_SCHEMA");
  assert.equal(validate("patchAgent", { description: "too short" }).code, "INVALID_SCHEMA");
  assert.equal(validate("patchAgent", { price: 0 }).code, "INVALID_SCHEMA");
  assert.equal(validate("patchAgent", { price: 100001 }).code, "INVALID_SCHEMA");
  assert.equal(validate("patchAgent", { price: -1 }).code, "INVALID_SCHEMA");
  assert.equal(validate("patchAgent", { category: "nope" }).code, "INVALID_SCHEMA");
  assert.equal(validate("patchAgent", { api_key: "x" }).code, "INVALID_SCHEMA");
});

test("protocol: schemas reject over-long identifiers", () => {
  const long = "x".repeat(129);
  assert.equal(invalid("openDeal", { id: long, buyer: "b", seller: "s", price: 1 }).field, "id");
  assert.equal(invalid("move", { dealId: "d", key: long, kind: "WALK" }).field, "key");
  assert.equal(invalid("moderationNote", { reason: long }).field, "reason");
  // 128 is the boundary: exactly at the limit still passes.
  assert.deepEqual(validate("openDeal", { id: "x".repeat(128), buyer: "b", seller: "s", price: 1 }), { ok: true });
});
