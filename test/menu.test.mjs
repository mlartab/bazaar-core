import test from "node:test";
import assert from "node:assert/strict";
import { MENU, allowedMoves } from "../src/menu.js";

test("menu: adding a row changes allowedMoves without editing code", () => {
  assert.deepEqual(allowedMoves("NEGOTIATING", "buyer"), ["OFFER", "ACCEPT", "WALK"]);
  assert.deepEqual(allowedMoves("NEGOTIATING", "seller"), ["OFFER", "ACCEPT", "WALK"]);
  for (const state of [
    "AGREED",
    "ESCROW_LOCKED",
    "EXECUTING",
    "DELIVERED",
    "VERIFYING",
    "SETTLED",
    "REJECTED",
  ]) {
    assert.deepEqual(allowedMoves(state, "buyer"), []);
    assert.deepEqual(allowedMoves(state, "seller"), []);
  }
  assert.deepEqual(allowedMoves("NOPE", "buyer"), []);
  assert.deepEqual(allowedMoves("NEGOTIATING", "ghost"), []);
  const first = allowedMoves("NEGOTIATING", "buyer");
  first.push("CHEAT");
  assert.deepEqual(allowedMoves("NEGOTIATING", "buyer"), ["OFFER", "ACCEPT", "WALK"]);

  assert.ok(!("AGREED" in MENU));
  MENU.AGREED = { buyer: ["WALK"], seller: [] };
  try {
    assert.deepEqual(allowedMoves("AGREED", "buyer"), ["WALK"]);
    assert.deepEqual(allowedMoves("AGREED", "seller"), []);
  } finally {
    delete MENU.AGREED;
  }
  assert.deepEqual(allowedMoves("AGREED", "buyer"), []);
});
