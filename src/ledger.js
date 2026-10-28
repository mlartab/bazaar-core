// Brick 1: pure ledger. Integers only. All-or-nothing. No dependencies.

export function createLedger() {
  return { reserve: 0, balances: {}, locks: {} };
}

// balanceOf returns a plain integer (0 for unknown agents), not the envelope.
// This is the one intentional exception to the envelope rule: it is a pure
// reader with no failure mode, so a later brick must not "fix" it to {ok,...}.
export function balanceOf(ledger, agentId) {
  const balance = ledger.balances[agentId];
  return typeof balance === "number" ? balance : 0;
}

export function checkInvariant(ledger) {
  if (!Number.isInteger(ledger.reserve) || ledger.reserve < 0) {
    return {
      ok: false,
      code: "INVARIANT_VIOLATION",
      message: "reserve must be a non-negative integer",
    };
  }
  let total = 0;
  for (const agentId of Object.keys(ledger.balances)) {
    const balance = ledger.balances[agentId];
    if (!Number.isInteger(balance) || balance < 0) {
      return {
        ok: false,
        code: "INVARIANT_VIOLATION",
        message: `balance for ${agentId} must be a non-negative integer`,
      };
    }
    total += balance;
  }
  for (const dealId of Object.keys(ledger.locks)) {
    const escrow = ledger.locks[dealId];
    if (
      escrow === undefined ||
      escrow === null ||
      !Number.isInteger(escrow.amount) ||
      escrow.amount <= 0
    ) {
      return {
        ok: false,
        code: "INVARIANT_VIOLATION",
        message: `lock for ${dealId} must hold a positive integer amount`,
      };
    }
    total += escrow.amount;
  }
  if (total !== ledger.reserve) {
    return {
      ok: false,
      code: "INVARIANT_VIOLATION",
      message: "balances plus locks must equal reserve",
    };
  }
  return { ok: true };
}

function isValidId(id) {
  return typeof id === "string" && id.length > 0;
}

function isValidAmount(amount) {
  return Number.isInteger(amount) && amount > 0;
}

function fail(code, message) {
  return { ok: false, code, message };
}

function snapshot(ledger) {
  const locks = {};
  for (const dealId of Object.keys(ledger.locks)) {
    locks[dealId] = { ...ledger.locks[dealId] };
  }
  return {
    reserve: ledger.reserve,
    balances: { ...ledger.balances },
    locks,
  };
}

function restore(ledger, snap) {
  ledger.reserve = snap.reserve;
  for (const key of Object.keys(ledger.balances)) delete ledger.balances[key];
  Object.assign(ledger.balances, snap.balances);
  for (const key of Object.keys(ledger.locks)) delete ledger.locks[key];
  for (const key of Object.keys(snap.locks)) ledger.locks[key] = { ...snap.locks[key] };
}

function closeOrRollback(ledger, snap, success) {
  const invariant = checkInvariant(ledger);
  if (!invariant.ok) {
    restore(ledger, snap);
    return fail("INVARIANT_VIOLATION", invariant.message);
  }
  return success;
}

export function deposit(ledger, agentId, amount) {
  if (!isValidId(agentId)) return fail("BAD_ID", "agentId must be a non-empty string");
  if (!isValidAmount(amount)) return fail("BAD_AMOUNT", "amount must be a positive integer");
  const snap = snapshot(ledger);
  ledger.reserve += amount;
  ledger.balances[agentId] = (ledger.balances[agentId] ?? 0) + amount;
  return closeOrRollback(ledger, snap, {
    ok: true,
    reserve: ledger.reserve,
    balance: ledger.balances[agentId],
  });
}

export function redeem(ledger, agentId, amount) {
  if (!isValidId(agentId)) return fail("BAD_ID", "agentId must be a non-empty string");
  if (!isValidAmount(amount)) return fail("BAD_AMOUNT", "amount must be a positive integer");
  if ((ledger.balances[agentId] ?? 0) < amount) {
    return fail("INSUFFICIENT_FUNDS", "agent balance is less than amount");
  }
  const snap = snapshot(ledger);
  ledger.reserve -= amount;
  ledger.balances[agentId] -= amount;
  return closeOrRollback(ledger, snap, {
    ok: true,
    reserve: ledger.reserve,
    balance: ledger.balances[agentId],
  });
}

export function lock(ledger, agentId, dealId, amount) {
  if (!isValidId(agentId)) return fail("BAD_ID", "agentId must be a non-empty string");
  if (!isValidId(dealId)) return fail("BAD_ID", "dealId must be a non-empty string");
  if (!isValidAmount(amount)) return fail("BAD_AMOUNT", "amount must be a positive integer");
  if (ledger.locks[dealId] !== undefined) {
    return fail("DEAL_EXISTS", "deal is already locked");
  }
  if ((ledger.balances[agentId] ?? 0) < amount) {
    return fail("INSUFFICIENT_FUNDS", "agent balance is less than amount");
  }
  const snap = snapshot(ledger);
  ledger.balances[agentId] -= amount;
  ledger.locks[dealId] = { agentId, amount };
  return closeOrRollback(ledger, snap, {
    ok: true,
    reserve: ledger.reserve,
    balance: ledger.balances[agentId],
    locked: amount,
  });
}

export function settle(ledger, dealId, sellerId) {
  if (!isValidId(dealId)) return fail("BAD_ID", "dealId must be a non-empty string");
  if (!isValidId(sellerId)) return fail("BAD_ID", "sellerId must be a non-empty string");
  const escrow = ledger.locks[dealId];
  if (escrow === undefined) return fail("NO_SUCH_DEAL", "deal has no lock to settle");
  // An account exists once it has a balance entry, even at zero. Money must
  // never go to a brand-new account, so an unknown seller is rejected.
  if (!Object.hasOwn(ledger.balances, sellerId)) {
    return fail("NO_SUCH_ACCOUNT", "seller must be an existing balance account");
  }
  const snap = snapshot(ledger);
  delete ledger.locks[dealId];
  ledger.balances[sellerId] += escrow.amount;
  return closeOrRollback(ledger, snap, {
    ok: true,
    reserve: ledger.reserve,
    balance: ledger.balances[sellerId],
    paid: escrow.amount,
  });
}

export function refund(ledger, dealId) {
  if (!isValidId(dealId)) return fail("BAD_ID", "dealId must be a non-empty string");
  const escrow = ledger.locks[dealId];
  if (escrow === undefined) return fail("NO_SUCH_DEAL", "deal has no lock to refund");
  const snap = snapshot(ledger);
  delete ledger.locks[dealId];
  ledger.balances[escrow.agentId] = (ledger.balances[escrow.agentId] ?? 0) + escrow.amount;
  return closeOrRollback(ledger, snap, {
    ok: true,
    reserve: ledger.reserve,
    balance: ledger.balances[escrow.agentId],
    refunded: escrow.amount,
  });
}
