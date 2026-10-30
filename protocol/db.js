// Brick 3: protocol storage. Pure SQLite via node:sqlite. No server.
//
// openStore(path) opens (or creates) the file at path, creates the four
// tables when missing, and returns a store. The store owns one connection;
// call close() when done. A bad path returns an error envelope instead of
// throwing, so callers get a clear error rather than a crash.

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  role TEXT,
  balance INTEGER,
  capability TEXT,
  status TEXT DEFAULT 'PENDING',
  status_reason TEXT,
  title TEXT,
  description TEXT,
  price INTEGER,
  category TEXT,
  api_key TEXT
);
CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  buyer TEXT,
  seller TEXT,
  price INTEGER,
  created_at INTEGER DEFAULT (unixepoch()),
  expires_at INTEGER,
  close_reason TEXT,
  delivery_expires_at INTEGER
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
    // WAL lets readers proceed during a write and the busy timeout turns
    // same-file contention (a second process, a checkpoint) into a wait
    // instead of an instant SQLITE_BUSY 500.
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec(SCHEMA);
    try {
      // Migration for files created before created_at existed: ADD COLUMN
      // throws when the column is already there, which is the common case.
      db.exec("ALTER TABLE deals ADD COLUMN created_at INTEGER DEFAULT (unixepoch())");
    } catch {
      // Column present: nothing to migrate.
    }
    // Session timeout columns. Pre-existing rows keep NULL expiry, which the
    // sweeper treats as "never expires": only deals opened under the timeout
    // regime can time out.
    for (const column of ["expires_at INTEGER", "close_reason TEXT", "delivery_expires_at INTEGER"]) {
      try {
        db.exec(`ALTER TABLE deals ADD COLUMN ${column}`);
      } catch {
        // Column present: nothing to migrate.
      }
    }
    // State-change stamp for the inspection-timeout sweeper. Backfilled from
    // created_at (unix seconds) so pre-migration rows age from birth rather
    // than expiring instantly or living forever; rows with neither stamp
    // never expire, same fail-frozen convention as the expiry columns.
    try {
      db.exec("ALTER TABLE deals ADD COLUMN updated_at INTEGER");
    } catch {
      // Column present: nothing to migrate.
    }
    try {
      db.exec("UPDATE deals SET updated_at = created_at * 1000 WHERE updated_at IS NULL AND created_at IS NOT NULL");
    } catch {
      // No updatable rows: nothing to backfill.
    }
    try {
      // Same shape of migration for the agent capability column.
      db.exec("ALTER TABLE agents ADD COLUMN capability TEXT");
    } catch {
      // Column present: nothing to migrate.
    }
    // Lifecycle columns. Old files carry review_status/review_message;
    // migrate them once, then drop the old pair so status has exactly one
    // source of truth. Every step is guarded: a throw means "already done".
    // NOTE: no DEFAULT here on purpose. A default would stamp every old row
    // before the mapping below runs; the backfill assigns each row explicitly.
    try {
      db.exec("ALTER TABLE agents ADD COLUMN status TEXT");
    } catch {
      // Column present: nothing to migrate.
    }
    try {
      db.exec("ALTER TABLE agents ADD COLUMN status_reason TEXT");
    } catch {
      // Column present: nothing to migrate.
    }
    try {
      db.exec(`UPDATE agents SET status = CASE review_status
        WHEN 'PENDING_REVIEW' THEN 'PENDING'
        WHEN 'ACTIVE' THEN 'ACTIVE'
        WHEN 'REJECTED' THEN 'REJECTED'
        ELSE 'PENDING' END,
        status_reason = review_message
        WHERE status IS NULL`);
    } catch {
      // Old columns already gone: nothing to backfill.
    }
    for (const column of ["review_status", "review_message"]) {
      try {
        db.exec(`ALTER TABLE agents DROP COLUMN ${column}`);
      } catch {
        // Already dropped: nothing to do.
      }
    }
    // Deliverable reference for the async AI Inspector. Same guarded
    // pattern: the throw means "already there" on new files.
    try {
      db.exec("ALTER TABLE deliveries ADD COLUMN delivery_url TEXT");
    } catch {
      // Column present: nothing to migrate.
    }
    // Marketplace listing fields. Same guarded pattern: the throws mean
    // "already there", which is the common case on old database files.
    for (const column of ["title TEXT", "description TEXT", "price INTEGER", "category TEXT"]) {
      try {
        db.exec(`ALTER TABLE agents ADD COLUMN ${column}`);
      } catch {
        // Column present: nothing to migrate.
      }
    }
    // Seller-declared delivery SLA (seconds). Old rows predate it and read
    // NULL, which the handler maps to the env default.
    try {
      db.exec("ALTER TABLE agents ADD COLUMN delivery_sla_seconds INTEGER DEFAULT 300");
    } catch {
      // Column present: nothing to migrate.
    }
    // Listing strategy columns. Same guarded pattern: the throws mean
    // "already there". Old rows read as negotiation services with no
    // floor, tags, or descriptor — identical to registering without them.
    for (const column of ["service_type TEXT DEFAULT 'negotiation'", "min_price INTEGER", "skills_json TEXT", "metadata_json TEXT"]) {
      try {
        db.exec(`ALTER TABLE agents ADD COLUMN ${column}`);
      } catch {
        // Column present: nothing to migrate.
      }
    }
    try {
      db.exec("UPDATE agents SET service_type = 'negotiation' WHERE service_type IS NULL");
    } catch {
      // Nothing to backfill.
    }
    // Per-deal snapshot of the listing SLA at open time, so later listing
    // edits never change a running deal. NULL = pre-snapshot row.
    try {
      db.exec("ALTER TABLE deals ADD COLUMN sla_ms INTEGER");
    } catch {
      // Column present: nothing to migrate.
    }
    // Agent credentials. Pre-key rows (and any fresh row saved without one)
    // get a random key: authentication must never fail open on NULL.
    try {
      db.exec("ALTER TABLE agents ADD COLUMN api_key TEXT");
    } catch {
      // Column present: nothing to migrate.
    }
    for (const row of db.prepare("SELECT id FROM agents WHERE api_key IS NULL").all()) {
      db.prepare("UPDATE agents SET api_key = ? WHERE id = ?").run(randomUUID(), row.id);
    }
    // Probation marker for AUTO_APPROVE onboarding. Nullable-tolerant:
    // older rows read as not-on-probation via COALESCE at read time.
    try {
      db.exec("ALTER TABLE agents ADD COLUMN probation INTEGER DEFAULT 0");
    } catch {
      // Column present: nothing to migrate.
    }
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
  const run = (sql, params = []) => db.prepare(sql).run(...params);
  const get = (sql, params = []) => plain(db.prepare(sql).get(...params));
  const all = (sql, params = []) => db.prepare(sql).all(...params).map(plain);

  // Listing strategy columns ride as JSON text in SQLite. Readers always
  // get parsed values: skills degrade to [] and metadata to null when the
  // column is missing or unparseable, never a raw JSON string or throw.
  const parseSkills = (value) => {
    if (typeof value !== "string" || value.length === 0) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : [];
    } catch {
      return [];
    }
  };
  const parseMetadata = (value) => {
    if (typeof value !== "string" || value.length === 0) return null;
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  const store = {
    close() {
      db.close();
    },

    saveAgent(agent) {
      if (!agent || !isValidId(agent.id)) return fail("BAD_ID", "agent must have a non-empty string id");
      run("INSERT INTO agents (id, role, balance, capability, status, status_reason, title, description, price, category, api_key, probation, delivery_sla_seconds, service_type, min_price, skills_json, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
        agent.id,
        agent.role ?? null,
        agent.balance ?? null,
        agent.capability ?? null,
        agent.status ?? "PENDING",
        agent.status_reason ?? null,
        agent.title ?? null,
        agent.description ?? null,
        agent.price ?? null,
        agent.category ?? null,
        // The server always passes a fresh key; this default keeps the
        // column invariant (never NULL) for direct store callers too.
        agent.api_key ?? randomUUID(),
        agent.probation === 1 ? 1 : 0,
        agent.delivery_sla_seconds ?? 300,
        agent.service_type ?? "negotiation",
        agent.min_price ?? null,
        // HTTP JSON bodies are always acyclic, so stringify cannot throw
        // here; direct store callers must pass JSON-compatible values too.
        agent.skills !== undefined ? JSON.stringify(agent.skills) : null,
        agent.metadata !== undefined ? JSON.stringify(agent.metadata) : null,
      ]);
      return { ok: true };
    },
    // Atomic key rotation: one UPDATE swaps the credential; the old key
    // stops resolving on the next lookup. Returns the new key.
    rotateAgentKey(id) {
      if (!isValidId(id)) return fail("BAD_ID", "agent must have a non-empty string id");
      const fresh = randomUUID();
      const result = run("UPDATE agents SET api_key = ? WHERE id = ?", [fresh, id]);
      if (result.changes === 0) return fail("NO_SUCH_AGENT", `no agent with id ${id}`);
      return { ok: true, api_key: fresh };
    },
    getAgentProbation(id) {
      if (!isValidId(id)) return null;
      const row = get("SELECT COALESCE(probation, 0) AS probation FROM agents WHERE id = ?", [id]);
      return row === undefined ? null : row.probation;
    },
    setAgentProbation(id, value) {
      if (!isValidId(id)) return fail("BAD_ID", "agent must have a non-empty string id");
      const result = run("UPDATE agents SET probation = ? WHERE id = ?", [value === 1 ? 1 : 0, id]);
      if (result.changes === 0) return fail("NO_SUCH_AGENT", `no agent with id ${id}`);
      return { ok: true };
    },
    // Credential lookup: the only reader that touches api_key, so keys never
    // leak into listing, status, or admin responses. Returns the frozen agent
    // shape on a hit, null otherwise.
    getAgentByKey(key) {
      if (typeof key !== "string" || key.length === 0) return null;
      return get("SELECT id, role, balance FROM agents WHERE api_key = ?", [key]) ?? null;
    },
    // Admin-only key recovery (approval response). Never exposed on a public
    // route: the status endpoint deliberately cannot return this.
    getAgentApiKey(id) {
      if (!isValidId(id)) return null;
      return get("SELECT api_key FROM agents WHERE id = ?", [id])?.api_key ?? null;
    },
    // Narrow capability reader for inspection routing. Returns the raw
    // string (possibly free-form or null); the inspector decides whether
    // it names a known capability.
    getAgentCapability(id) {
      if (!isValidId(id)) return null;
      return get("SELECT capability FROM agents WHERE id = ?", [id])?.capability ?? null;
    },
    getAgent(id) {
      // Column list frozen: existing readers assert this exact shape.
      return get("SELECT id, role, balance FROM agents WHERE id = ?", [id]) ?? null;
    },
    listAgents(filters = {}) {
      // The public marketplace sees only approved *seller* listings.
      // Buyers are never merchandise: even an ACTIVE buyer stays invisible
      // here by construction rather than by UI filtering. Suspension and
      // retirement change visibility only: escrows, deals, and balances
      // are untouched, so in-flight work settles naturally.
      // Discovery filters are all optional; absent means unfiltered. Skill
      // matching uses json_each so tags stay exact, never substring hits.
      const { skill, service_type, max_price } = filters;
      const params = [];
      let sql = "SELECT id, role, capability, title, description, price, category, service_type, min_price, skills_json, metadata_json FROM agents WHERE role = 'seller' AND status = 'ACTIVE'";
      if (service_type !== undefined) {
        sql += " AND service_type = ?";
        params.push(service_type);
      }
      if (skill !== undefined) {
        sql += " AND EXISTS (SELECT 1 FROM json_each(agents.skills_json) WHERE value = ?)";
        params.push(skill);
      }
      if (max_price !== undefined) {
        // Negotiation services resolve to their floor; fixed-price listings
        // to their price. Unpriced rows cannot prove cheapness, so a bound
        // excludes them while the unfiltered list keeps them.
        sql += " AND COALESCE(CASE WHEN service_type = 'negotiation' THEN min_price ELSE price END, price) <= ?";
        params.push(max_price);
      }
      sql += " ORDER BY rowid";
      return all(sql, params).map(({ skills_json, metadata_json, ...row }) => ({
        ...row,
        service_type: row.service_type ?? "negotiation",
        skills: parseSkills(skills_json),
        metadata: parseMetadata(metadata_json),
      }));
    },
    listAllAgents() {
      // Operator-only: moderation needs every row including hidden ones.
      return all("SELECT id, role, balance, capability, status, status_reason, title, description, price, category, service_type, min_price, skills_json, metadata_json FROM agents ORDER BY rowid").map(({ skills_json, metadata_json, ...row }) => ({
        ...row,
        service_type: row.service_type ?? "negotiation",
        skills: parseSkills(skills_json),
        metadata: parseMetadata(metadata_json),
      }));
    },
    getAgentStatus(id) {
      return get("SELECT status, status_reason FROM agents WHERE id = ?", [id]) ?? null;
    },
    // The lifecycle table. SUSPENDED↔ACTIVE is reversible (the demo path);
    // REJECTED and RETIRED are terminal — a rejected agent re-registers under
    // a new id. RETIRE from PENDING is the spam-discard path.
    // Suspension is visibility-only: it never touches deals or escrows.
    setAgentStatus(id, status, reason) {
      const row = get("SELECT status FROM agents WHERE id = ?", [id]);
      if (row === undefined) return fail("NO_SUCH_AGENT", `no agent with id ${id}`);
      const allowed = {
        PENDING: ["ACTIVE", "REJECTED", "RETIRED"],
        ACTIVE: ["SUSPENDED", "RETIRED"],
        SUSPENDED: ["ACTIVE", "RETIRED"],
        REJECTED: [],
        RETIRED: [],
      };
      if (!(allowed[row.status] ?? []).includes(status)) {
        return fail("ILLEGAL_TRANSITION", `cannot move agent from ${row.status} to ${status}`);
      }
      run("UPDATE agents SET status = ?, status_reason = ? WHERE id = ?", [status, reason ?? null, id]);
      return { ok: true, from: row.status, to: status };
    },
    getAgentCategory(id) {
      if (!isValidId(id)) return null;
      return get("SELECT category FROM agents WHERE id = ?", [id])?.category ?? null;
    },
    getAgentSla(id) {
      if (!isValidId(id)) return null;
      return get("SELECT delivery_sla_seconds FROM agents WHERE id = ?", [id])?.delivery_sla_seconds ?? null;
    },
    // Allowlisted partial update for operator edits. Unknown fields are
    // rejected by the caller (patchAgent schema); here only known columns
    // are ever written.
    updateAgent(id, patch) {
      if (!isValidId(id)) return fail("BAD_ID", "agent must have a non-empty string id");
      const sets = [];
      const params = [];
      for (const column of ["title", "description", "price", "category", "delivery_sla_seconds", "service_type", "min_price"]) {
        if (patch[column] !== undefined) {
          sets.push(`${column} = ?`);
          params.push(patch[column]);
        }
      }
      // Strategy columns ride as JSON text, matching saveAgent.
      if (patch.skills !== undefined) {
        sets.push("skills_json = ?");
        params.push(JSON.stringify(patch.skills));
      }
      if (patch.metadata !== undefined) {
        sets.push("metadata_json = ?");
        params.push(JSON.stringify(patch.metadata));
      }
      if (sets.length === 0) return fail("BAD_PATCH", "patch must change at least one listing field");
      params.push(id);
      const result = run(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`, params);
      if (result.changes === 0) return fail("NO_SUCH_AGENT", `no agent with id ${id}`);
      return { ok: true };
    },
    // Operator removal. Refused while the agent has non-terminal deals —
    // money history is never orphaned by an admin click. Deal and move rows
    // stay as audit history; only the agent row (and its key) goes away.
    deleteAgent(id) {
      if (!isValidId(id)) return fail("BAD_ID", "agent must have a non-empty string id");
      if (get("SELECT id FROM agents WHERE id = ?", [id]) === undefined) {
        return fail("NO_SUCH_AGENT", `no agent with id ${id}`);
      }
      const live = get(
        "SELECT COUNT(*) AS n FROM deals WHERE (buyer = ? OR seller = ?) AND state NOT IN ('SETTLED', 'REJECTED')",
        [id, id],
      );
      if (live.n > 0) {
        return fail("AGENT_HAS_LIVE_DEALS", `agent ${id} still has live deals`);
      }
      run("DELETE FROM agents WHERE id = ?", [id]);
      return { ok: true };
    },

    saveDeal(deal) {
      if (!deal || !isValidId(deal.id)) return fail("BAD_ID", "deal must have a non-empty string id");
      if (typeof deal.state !== "string" || deal.state.length === 0) {
        return fail("BAD_STATE", "deal must have a non-empty string state");
      }
      run("INSERT INTO deals (id, state, buyer, seller, price, expires_at, close_reason, delivery_expires_at, sla_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
        deal.id,
        deal.state,
        deal.buyer ?? null,
        deal.seller ?? null,
        deal.price ?? null,
        deal.expires_at ?? null,
        deal.close_reason ?? null,
        deal.delivery_expires_at ?? null,
        deal.sla_ms ?? null,
      ]);
      return { ok: true };
    },
    // Full deal row for the detail endpoint (timestamps, SLA snapshot,
    // close reason). getDeal's frozen shape is untouched.
    getDealRow(id) {
      if (!isValidId(id)) return null;
      return get("SELECT id, state, buyer, seller, price, created_at, expires_at, close_reason, delivery_expires_at, sla_ms, updated_at FROM deals WHERE id = ?", [id]) ?? null;
    },
    getDeal(id) {
      // Column list frozen: existing readers assert this exact shape.
      return get("SELECT id, state, buyer, seller, price FROM deals WHERE id = ?", [id]) ?? null;
    },
    listDeals() {
      return all("SELECT id, state, buyer, seller, price, created_at, expires_at, close_reason, delivery_expires_at FROM deals ORDER BY rowid");
    },
    // Post-payment stalls: escrow captured but no delivery before the stamp.
    // created_at is unix seconds (not ms) and predates the stamp regime, so
    // NULL-stamp legacy rows fall back to it instead of living forever.
    listStaleEscrows(now, timeoutMs) {
      return all(
        "SELECT id, state, buyer, seller, price FROM deals WHERE state = 'ESCROW_LOCKED' AND (delivery_expires_at < ? OR (delivery_expires_at IS NULL AND created_at IS NOT NULL AND created_at * 1000 < ?)) ORDER BY rowid",
        [now, now - timeoutMs],
      );
    },
    setDealDeliveryExpiry(id, ts) {
      const result = run("UPDATE deals SET delivery_expires_at = ? WHERE id = ?", [ts, id]);
      if (result.changes === 0) return fail("NO_SUCH_DEAL", `no deal with id ${id}`);
      return { ok: true };
    },
    // Agent-scoped listing: an agent sees only deals where they are buyer or
    // seller, oldest first within the page. Status is validated by the
    // caller against EDGES; limit/offset are integers by then.
    listDealsByParty(agentId, { status, limit, offset }) {
      const params = [agentId, agentId];
      let filter = "";
      if (status !== undefined) {
        filter = " AND state = ?";
        params.push(status);
      }
      params.push(limit, offset);
      return all(
        `SELECT id, state, buyer, seller, price, created_at, expires_at, close_reason, delivery_expires_at FROM deals WHERE (buyer = ? OR seller = ?)${filter} ORDER BY rowid LIMIT ? OFFSET ?`,
        params,
      );
    },
    countDealsByParty(agentId, status) {
      const params = [agentId, agentId];
      let filter = "";
      if (status !== undefined) {
        filter = " AND state = ?";
        params.push(status);
      }
      return get(
        `SELECT COUNT(*) AS n FROM deals WHERE (buyer = ? OR seller = ?)${filter}`,
        params,
      ).n;
    },
    // Open deals where the agent is buyer OR seller (non-terminal states).
    countOpenDealsByParty(agentId) {
      return get(
        "SELECT COUNT(*) AS n FROM deals WHERE (buyer = ? OR seller = ?) AND state NOT IN ('SETTLED', 'REJECTED')",
        [agentId, agentId],
      ).n;
    },
    // Operator detail: full row plus probation marker. Separate from the
    // frozen list shapes so existing readers never change.
    getAgentDetail(id) {
      if (!isValidId(id)) return null;
      const row = get("SELECT id, role, balance, capability, status, status_reason, title, description, price, category, COALESCE(probation, 0) AS probation, service_type, min_price, skills_json, metadata_json FROM agents WHERE id = ?", [id]);
      if (row === undefined || row === null) return null;
      const { skills_json, metadata_json, ...rest } = row;
      return {
        ...rest,
        service_type: rest.service_type ?? "negotiation",
        skills: parseSkills(skills_json),
        metadata: parseMetadata(metadata_json),
      };
    },
    listExpiringDeals(now) {
      // Only live negotiations can time out: terminal states are done, and
      // NULL expiry means the deal predates the timeout regime.
      return all(
        "SELECT id, state, buyer, seller, price FROM deals WHERE state IN ('NEGOTIATING','AGREED') AND expires_at IS NOT NULL AND expires_at < ? ORDER BY rowid",
        [now],
      );
    },
    setDealCloseReason(id, reason) {
      const result = run("UPDATE deals SET close_reason = ? WHERE id = ?", [reason, id]);
      if (result.changes === 0) return fail("NO_SUCH_DEAL", `no deal with id ${id}`);
      return { ok: true };
    },
    dealStats() {
      // TVL is DB-derived on purpose: escrow locks live in the in-memory
      // ledger and would not survive a restart, while deal rows do. Active
      // means any non-terminal state; AGREED counts because ACCEPT locks.
      const total = get("SELECT COUNT(*) AS n FROM deals").n;
      const active = get("SELECT COUNT(*) AS n FROM deals WHERE state NOT IN ('SETTLED','REJECTED')").n;
      const tvl = get("SELECT COALESCE(SUM(price),0) AS s FROM deals WHERE state NOT IN ('SETTLED','REJECTED')").s;
      const settled = get("SELECT COUNT(*) AS n FROM deals WHERE state = 'SETTLED'").n;
      const rejected = get("SELECT COUNT(*) AS n FROM deals WHERE state = 'REJECTED'").n;
      return { totalDeals: total, activeDeals: active, tvl, settled, rejected };
    },
    setDealState(id, state) {
      if (typeof state !== "string" || state.length === 0) {
        return fail("BAD_STATE", "state must be a non-empty string");
      }
      // updated_at rides every transition: setDealState is the single choke
      // point all state changes flow through, so the inspection sweeper can
      // trust the stamp without per-callsite edits.
      const result = run("UPDATE deals SET state = ?, updated_at = ? WHERE id = ?", [state, Date.now(), id]);
      if (result.changes === 0) return fail("NO_SUCH_DEAL", `no deal with id ${id}`);
      return { ok: true };
    },
    // Frozen inspection: VERIFYING deals the AI never verdicts. NULL
    // updated_at (neither stamp regime) never expires — fail-frozen.
    listStaleVerifying(now, timeoutMs) {
      return all(
        "SELECT id, state, buyer, seller, price FROM deals WHERE state = 'VERIFYING' AND updated_at IS NOT NULL AND updated_at < ? ORDER BY rowid",
        [now - timeoutMs],
      );
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
      try {
        run("INSERT INTO deliveries (id, deal_id, status, delivery_url) VALUES (?, ?, ?, ?)", [
          delivery.id,
          delivery.deal_id,
          delivery.status ?? null,
          delivery.delivery_url ?? null,
        ]);
      } catch (err) {
        // Same UNIQUE mapping as saveMove: a repeated delivery id is a
        // client retry, not a crash. deliveries.id is the PRIMARY KEY.
        if (err?.errcode === 2067 || String(err?.message ?? "").includes("UNIQUE constraint failed")) {
          return fail("DUPLICATE_DELIVERY", `delivery ${delivery.id} was already recorded`);
        }
        throw err;
      }
      return { ok: true };
    },
    getDelivery(id) {
      return get("SELECT id, deal_id, status, delivery_url FROM deliveries WHERE id = ?", [id]) ?? null;
    },
  };

  return store;
}
