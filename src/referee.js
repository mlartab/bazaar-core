// Brick 1: pure referee. Stateless; the caller owns seenKeys and seenOffers.
import { allowedMoves } from "./menu.js";

// OFFER and ACCEPT both carry a price that locks funds, so both get the price
// rules. WALK carries no price and skips them.
const PRICED_KINDS = new Set(["OFFER", "ACCEPT"]);

function contains(collection, value) {
  if (collection instanceof Set) return collection.has(value);
  if (Array.isArray(collection)) return collection.includes(value);
  throw new TypeError("duplicate collection must be an array or a Set");
}

function hasPriceRules(move) {
  return PRICED_KINDS.has(move.kind);
}

// Ordered rule table, deliberately exported and mutable so a later brick (or a
// scale test) can add a rule as one entry. validate runs them in order and the
// first failure wins.
export const RULES = [
  {
    code: "WRONG_STATE",
    message: "move is only allowed while NEGOTIATING",
    check: (_move, ctx) => ctx.state === "NEGOTIATING",
  },
  {
    code: "OFF_MENU",
    message: "move kind is not on the menu for this state and role",
    check: (move, ctx) => allowedMoves(ctx.state, ctx.role).includes(move.kind),
  },
  {
    code: "DUPLICATE_MOVE",
    message: "move key was already seen",
    check: (move, ctx) => !contains(ctx.seenKeys, move.key),
  },
  {
    code: "DUPLICATE_OFFER",
    message: "this price was already offered",
    check: (move, ctx) => !hasPriceRules(move) || !contains(ctx.seenOffers, move.price),
  },
  {
    code: "BAD_PRICE",
    message: "price must be a positive integer",
    check: (move, _ctx) =>
      !hasPriceRules(move) || (Number.isInteger(move.price) && move.price > 0),
  },
  {
    code: "BUDGET_REQUIRED",
    message: "budget is required for buyer price moves",
    check: (move, ctx) =>
      !hasPriceRules(move) || ctx.role !== "buyer" || ctx.budget !== undefined,
  },
  {
    code: "OVER_BUDGET",
    message: "price exceeds the budget",
    check: (move, ctx) =>
      !hasPriceRules(move) ||
      ctx.role !== "buyer" ||
      ctx.budget === undefined ||
      move.price <= ctx.budget,
  },
  {
    code: "FLOOR_REQUIRED",
    message: "floor is required for seller price moves",
    check: (move, ctx) =>
      !hasPriceRules(move) || ctx.role !== "seller" || ctx.floor !== undefined,
  },
  {
    code: "UNDER_FLOOR",
    message: "price is below the floor",
    check: (move, ctx) =>
      !hasPriceRules(move) ||
      ctx.role !== "seller" ||
      ctx.floor === undefined ||
      move.price >= ctx.floor,
  },
];

function isValidContext(ctx) {
  if (typeof ctx !== "object" || ctx === null) return false;
  for (const collection of [ctx.seenKeys, ctx.seenOffers]) {
    if (!(Array.isArray(collection) || collection instanceof Set)) return false;
  }
  return true;
}

export function validate(move, ctx) {
  if (!isValidContext(ctx)) {
    return { ok: false, code: "INVALID_CONTEXT", message: "context must have array or Set seenKeys and seenOffers" };
  }
  for (const rule of RULES) {
    if (!rule.check(move, ctx)) {
      return { ok: false, code: rule.code, message: rule.message };
    }
  }
  return { ok: true };
}
