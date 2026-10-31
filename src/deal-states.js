// Brick 2: pure deal state machine. No server, no model calls, no dependencies.

// EDGES maps state -> allowed next states. Plain data, deliberately exported
// and mutable so later bricks (and scale tests) can extend it at runtime.
// SETTLED and REJECTED are terminal: they map to no outgoing edges.
export const EDGES = {
  // REJECTED rides every live state: the sweeper expires NEGOTIATING and
  // AGREED deals, refunds stale ESCROW_LOCKED captures, and unfreezes
  // VERIFYING ones — all through transition(), so the machine stays the
  // single source of truth for every legal move.
  NEGOTIATING: ["AGREED", "REJECTED"],
  AGREED: ["ESCROW_LOCKED", "REJECTED"],
  ESCROW_LOCKED: ["EXECUTING", "REJECTED"],
  EXECUTING: ["DELIVERED"],
  DELIVERED: ["VERIFYING"],
  VERIFYING: ["SETTLED", "REJECTED"],
  SETTLED: [],
  REJECTED: [],
};

export function transition(deal, to) {
  if (typeof deal !== "object" || deal === null || typeof deal.state !== "string") {
    return { ok: false, code: "INVALID_DEAL", message: "deal must be an object with a string state" };
  }
  if (!Object.hasOwn(EDGES, to)) {
    return { ok: false, code: "UNKNOWN_STATE", message: `unknown target state: ${to}` };
  }
  const next = EDGES[deal.state];
  if (!Array.isArray(next) || !next.includes(to)) {
    return {
      ok: false,
      code: "ILLEGAL_TRANSITION",
      message: `cannot transition from ${deal.state} to ${to}`,
    };
  }
  return {
    ok: true,
    deal: { ...deal, state: to },
    event: { type: "STATE", from: deal.state, to },
  };
}
