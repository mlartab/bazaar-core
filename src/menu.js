// Brick 1: pure menu. No server, no model calls, no dependencies.

// MENU maps state -> role -> moves. Plain data, deliberately exported and
// mutable so later bricks (and scale tests) can extend it at runtime.
export const MENU = {
  NEGOTIATING: {
    buyer: ["OFFER", "ACCEPT", "WALK"],
    seller: ["OFFER", "ACCEPT", "WALK"],
  },
  // Post-negotiation states name the protocol action each side can take
  // next. These run through their own endpoints (pay, delivery), not the
  // moves endpoint — the referee's WRONG_STATE rule keeps moves
  // NEGOTIATING-only, so these entries fix the display contract without
  // changing any validation outcome. WALK is deliberately absent past
  // NEGOTIATING: no endpoint handles it outside negotiation, so listing
  // it would advertise an unreachable option.
  AGREED: {
    buyer: ["PAY"],
    seller: [],
  },
  ESCROW_LOCKED: {
    buyer: [],
    seller: ["DELIVER"],
  },
  EXECUTING: {
    buyer: [],
    seller: ["DELIVER"],
  },
  DELIVERED: {
    buyer: [],
    seller: [],
  },
  VERIFYING: {
    buyer: [],
    seller: [],
  },
  SETTLED: {
    buyer: [],
    seller: [],
  },
  REJECTED: {
    buyer: [],
    seller: [],
  },
};

// ACTIONS maps every menu entry to the concrete endpoint that executes
// it. MENU names *what* is legal in a state; ACTIONS names *where* to send
// it. Additive-only: allowedMoves keeps returning plain string arrays, and
// agents cache the full map from any deal response instead of guessing URLs.
export const ACTIONS = {
  OFFER: { method: "POST", path: "/api/deals/:id/moves", body: "{ key, kind: 'OFFER', price }" },
  ACCEPT: { method: "POST", path: "/api/deals/:id/moves", body: "{ key, kind: 'ACCEPT', price }" },
  WALK: { method: "POST", path: "/api/deals/:id/moves", body: "{ key, kind: 'WALK' }" },
  PAY: { method: "POST", path: "/api/deals/:id/pay", body: null },
  DELIVER: { method: "POST", path: "/api/deals/:id/delivery", body: "{ id, deliveryUrl, capability? }" },
};

// allowedMoves returns a plain array, not the envelope, because it is a pure reader.
export function allowedMoves(state, role) {
  const byRole = MENU[state];
  if (byRole === undefined || byRole === null) return [];
  const moves = byRole[role];
  if (!Array.isArray(moves)) return [];
  return [...moves];
}
