// Brick 3: protocol storage. Pure SQLite via node:sqlite. No server.
//
// openStore(path) opens (or creates) the file at path, creates the four
// tables when missing, and returns a store. The store owns one connection;
// call close() when done. A bad path returns an error envelope instead of
// throwing, so callers get a clear error rather than a crash.

import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  role TEXT,
  balance INTEGER
);
CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  buyer TEXT,
  seller TEXT,
  price INTEGER
);
CREATE TABLE IF NOT EXISTS moves (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals (id),
  key TEXT NOT NULL,
  kind TEXT,
  price INTEGER,
  -- One key per deal: the storage-level backstop behind the referee's
  -- DUPLICATE_MOVE rule, so a repeated key fails even if the check above is bypassed.
  UNIQUE (deal_id, key)
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals (id),
  status TEXT
);
`;

function fail(code, message) {
  return { ok: false, code, message };
}

function isValidId(id) {
  return typeof id === "string" && id.length > 0;
}

export function openStore(path) {
  if (typeof path !== "string" || path.length === 0) {
    return fail("BAD_PATH", "path must be a non-empty string");
  }
  let db;
  try {
    db = new DatabaseSync(path);
  } catch (err) {
    return fail("BAD_PATH", err?.message ?? "cannot open database file");
  }
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
  } catch (err) {
    try {
      db.close();
    } catch {
      // Ignore close errors while reporting the original failure.
    }
    return fail("DB_ERROR", err?.message ?? "cannot initialise database schema");
  }

  // node:sqlite returns null-prototype rows, which fail strict deep-equal
  // checks downstream; normalize to plain objects at the boundary.
  const plain = (row) => (row === undefined ? undefined : { ...row });
  const run = (sql, params) => db.prepare(sql).run(...params);
  const get = (sql, params) => plain(db.prepare(sql).get(...params));
  const all = (sql, params) => db.prepare(sql).all(...params).map(plain);

  const store = {
    close() {
      db.close();
    },

    saveAgent(agent) {
      if (!agent || !isValidId(agent.id)) return fail("BAD_ID", "agent must have a non-empty string id");
      run("INSERT INTO agents (id, role, balance) VALUES (?, ?, ?)", [
        agent.id,
        agent.role ?? null,
        agent.balance ?? null,
      ]);
      return { ok: true };
    },
    getAgent(id) {
      return get("SELECT id, role, balance FROM agents WHERE id = ?", [id]) ?? null;
    },

    saveDeal(deal) {
      if (!deal || !isValidId(deal.id)) return fail("BAD_ID", "deal must have a non-empty string id");
      if (typeof deal.state !== "string" || deal.state.length === 0) {
        return fail("BAD_STATE", "deal must have a non-empty string state");
      }
      run("INSERT INTO deals (id, state, buyer, seller, price) VALUES (?, ?, ?, ?, ?)", [
        deal.id,
        deal.state,
        deal.buyer ?? null,
        deal.seller ?? null,
        deal.price ?? null,
      ]);
      return { ok: true };
    },
    getDeal(id) {
      return get("SELECT id, state, buyer, seller, price FROM deals WHERE id = ?", [id]) ?? null;
    },
    setDealState(id, state) {
      if (typeof state !== "string" || state.length === 0) {
        return fail("BAD_STATE", "state must be a non-empty string");
      }
      const result = run("UPDATE deals SET state = ? WHERE id = ?", [state, id]);
      if (result.changes === 0) return fail("NO_SUCH_DEAL", `no deal with id ${id}`);
      return { ok: true };
    },

    saveMove(move) {
      if (!move || !isValidId(move.id)) return fail("BAD_ID", "move must have a non-empty string id");
      if (!isValidId(move.deal_id)) return fail("BAD_ID", "move must have a non-empty string deal_id");
      if (typeof move.key !== "string" || move.key.length === 0) {
        return fail("BAD_KEY", "move must have a non-empty string key");
      }
      try {
        run("INSERT INTO moves (id, deal_id, key, kind, price) VALUES (?, ?, ?, ?, ?)", [
          move.id,
          move.deal_id,
          move.key,
          move.kind ?? null,
          move.price ?? null,
        ]);
      } catch (err) {
        // node:sqlite reports constraint violations as generic
        // ERR_SQLITE_ERROR, so match the extended code for UNIQUE (2067)
        // instead of a code string that never arrives.
        if (err?.errcode === 2067 || String(err?.message ?? "").includes("UNIQUE constraint failed")) {
          return fail("DUPLICATE_MOVE", `move key ${move.key} was already stored for deal ${move.deal_id}`);
        }
        throw err;
      }
      return { ok: true };
    },
    listMoves(dealId) {
      return all("SELECT id, deal_id, key, kind, price FROM moves WHERE deal_id = ? ORDER BY rowid", [dealId]);
    },

    saveDelivery(delivery) {
      if (!delivery || !isValidId(delivery.id)) {
        return fail("BAD_ID", "delivery must have a non-empty string id");
      }
      if (!isValidId(delivery.deal_id)) {
        return fail("BAD_ID", "delivery must have a non-empty string deal_id");
      }
      run("INSERT INTO deliveries (id, deal_id, status) VALUES (?, ?, ?)", [
        delivery.id,
        delivery.deal_id,
        delivery.status ?? null,
      ]);
      return { ok: true };
    },
    getDelivery(id) {
      return get("SELECT id, deal_id, status FROM deliveries WHERE id = ?", [id]) ?? null;
    },
  };

  return store;
}
