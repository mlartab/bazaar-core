// Founder's Control Station: live SSE deal events plus a debounced
// dashboard refresh for metrics, deals, and traffic, plus the agent
// directory and audit log. A slow poll backs up the stream. Reads are keyless except the admin subtree, which needs the
// Bearer secret. Only moderation POSTs, each with a fresh Idempotency-Key.

const $ = (id) => document.getElementById(id);
const SECRET_KEY = "bazaar-admin-secret";
let paused = false;
let timer = null;
let scrollPaused = false;
let clearedBefore = 0;
let logQuery = "";
let stream = null;
let streamLive = false;
let refreshQueued = false;

// Debounced full refresh after a live event: the stream carries deal
// events, not traffic rows or totals, so one dashboard round trip (at most
// one per 500 ms) recomputes everything the tick body renders.
function queueRefresh() {
  if (refreshQueued || paused) return;
  refreshQueued = true;
  setTimeout(() => {
    refreshQueued = false;
    tick();
  }, 500);
}

function setMode(live) {
  streamLive = live;
  const text = $("net-text");
  if (text === null) return;
  text.dataset.mode = live ? "live" : "poll";
}

function connectStream() {
  if (typeof EventSource === "undefined" || !secret()) return;
  try {
    stream = new EventSource(`/api/admin/events/stream?token=${encodeURIComponent(secret())}`);
  } catch {
    return;
  }
  stream.onopen = () => setMode(true);
  stream.onmessage = () => queueRefresh();
  stream.onerror = () => {
    // Automatic fallback: close the broken stream and poll every 2 s
    // until the next successful tick reopens the stream.
    try { stream.close(); } catch { /* already closed */ }
    stream = null;
    setMode(false);
    if (!paused) {
      if (timer !== null) clearInterval(timer);
      timer = setInterval(tick, 2000);
    }
  };
}

const secret = () => localStorage.getItem(SECRET_KEY) ?? "";

// Tooltips live on ? badges, not on the labels: every [data-tip] keeps its
// text as the source, and one badge per element owns the hover. Runs once
// at load; the poll loop only replaces row markup, never labeled chrome.
for (const el of document.querySelectorAll("[data-tip]")) {
  if (el.querySelector(":scope > .tip-badge") !== null) continue;
  const badge = document.createElement("span");
  badge.className = "tip-badge";
  badge.textContent = "?";
  badge.setAttribute("data-tip", el.getAttribute("data-tip"));
  el.appendChild(badge);
}

// No secret, no console: the login page owns authentication.
if (!secret()) {
  location.href = "/login";
}

async function fetchJSON(path) {
  return adminFetch(path);
}

// Central admin fetch: every admin call carries the Bearer secret, 401
// bounces to login, and failures throw an Error carrying .code/.status.
async function adminFetch(path, { method = "GET", body, idempotency = false } = {}) {
  const headers = { authorization: `Bearer ${secret()}` };
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  if (idempotency) headers["idempotency-key"] = crypto.randomUUID();
  const res = await fetch(path, { method, headers, body: payload });
  if (res.status === 401) {
    localStorage.removeItem(SECRET_KEY);
    location.href = "/login";
    throw new Error("locked");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    const error = new Error(`${method} ${path} -> ${err?.error?.code ?? res.status}`);
    error.code = err?.error?.code ?? String(res.status);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

// Toast notifications: non-blocking, top-right, auto-dismissing.
function toast(message, kind = "info") {
  const holder = $("toasts");
  if (holder === null) return;
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  holder.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 4200);
}

// Generic modal: renders title/sub/body/actions into the shared #modal
// shell. Backdrop click, the ✕ button, and Escape all cancel; focus lands
// on the first field. onSubmit resolves to a string to show an inline
// error and stay open, or to null/undefined to close. Submit shows a
// Saving… state while the async work runs.
let modalCleanup = null;

function closeModal() {
  if (modalCleanup !== null) {
    const fn = modalCleanup;
    modalCleanup = null;
    fn();
  }
  $("modal").hidden = true;
}

function openModal({ title, sub = "", bodyHTML = "", submitLabel = "Confirm", danger = false, onSubmit }) {
  closeModal();
  $("modal-title").textContent = title;
  $("modal-agent").textContent = sub;
  $("modal-body").innerHTML = bodyHTML;
  const err = $("modal-error");
  err.hidden = true;
  err.textContent = "";
  const foot = $("modal-foot");
  foot.innerHTML = "";
  const cancel = document.createElement("button");
  cancel.className = "btn btn-ghost";
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", closeModal);
  const submit = document.createElement("button");
  submit.className = danger ? "btn btn-danger" : "btn";
  submit.type = "button";
  submit.textContent = submitLabel;
  const run = async () => {
    submit.disabled = true;
    const original = submit.textContent;
    submit.textContent = "Saving…";
    try {
      const message = await onSubmit();
      if (typeof message === "string" && message !== "") {
        err.textContent = message;
        err.hidden = false;
        return;
      }
      closeModal();
    } catch (thrown) {
      err.textContent = thrown?.message ?? "Request failed.";
      err.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = original;
    }
  };
  submit.addEventListener("click", run);
  foot.append(cancel, submit);
  const onKey = (e) => {
    if (e.key === "Escape") closeModal();
    else if (e.key === "Enter" && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "BUTTON") run();
  };
  document.addEventListener("keydown", onKey);
  modalCleanup = () => document.removeEventListener("keydown", onKey);
  $("modal-x").onclick = closeModal;
  $("modal").hidden = false;
  const first = $("modal-body").querySelector("input, select, textarea");
  if (first !== null) first.focus();
}

$("modal").addEventListener("click", (e) => {
  if (e.target === $("modal")) closeModal();
});

const STATE_PILL = {
  NEGOTIATING: "negotiating",
  AGREED: "agreed",
  ESCROW_LOCKED: "escrow",
  EXECUTING: "executing",
  DELIVERED: "delivered",
  VERIFYING: "verifying",
  SETTLED: "settled",
  REJECTED: "rejected",
};

function pill(state) {
  const cls = STATE_PILL[state] ?? "active";
  return `<span class="pill ${cls}" data-state="${esc(state)}">${esc(state)}</span>`;
}

// Ordered pipeline positions for the Global State Machine progress bars.
const STATE_ORDER = ["NEGOTIATING", "AGREED", "ESCROW_LOCKED", "EXECUTING", "DELIVERED", "VERIFYING", "SETTLED", "REJECTED"];

function renderStateMachine(deals) {
  const strip = $("sm-strip");
  const flows = $("sm-flows");
  if (strip === null || flows === null) return;
  const counts = Object.fromEntries(STATE_ORDER.map((s) => [s, 0]));
  for (const d of deals) {
    if (d.state in counts) counts[d.state] += 1;
  }
  strip.innerHTML = STATE_ORDER.map(
    (s) => `<div class="sm-node${counts[s] > 0 ? " hot" : ""}" data-state="${s}" data-count="${counts[s]}"><div class="sm-count">${counts[s]}</div><div class="sm-label">${s}</div></div>`,
  ).join("");
  const live = deals.filter((d) => d.state !== "SETTLED" && d.state !== "REJECTED").slice(0, 12);
  flows.innerHTML = live
    .map((d) => {
      const idx = STATE_ORDER.indexOf(d.state);
      const pct = idx < 0 ? 0 : Math.round(((idx + 1) / (STATE_ORDER.length - 1)) * 100);
      return `<div class="sm-flow" data-deal-id="${esc(d.id)}" data-state="${esc(d.state)}" data-price="${d.price ?? ""}"><span class="sm-id">${esc(d.id)}</span><span class="sm-bar"><i style="width:${pct}%"></i></span><span>${esc(d.state)}</span></div>`;
    })
    .join("");
}

function statusPill(status) {
  const cls =
    status === "ACTIVE" ? "active" : status === "PENDING" ? "pending" : status === "SUSPENDED" ? "suspended" : "rejected";
  return `<span class="pill ${cls}" data-status="${esc(status)}">${esc(status)}</span>`;
}

// Countdown for live negotiations: the sweeper rejects whatever is still
// open when the stamp passes, so the operator sees the window closing.
// Rows the timeout regime never touches (terminal, legacy NULL) show "—".
function expiresIn(d) {
  if ((d.state !== "NEGOTIATING" && d.state !== "AGREED") || typeof d.expires_at !== "number") return "—";
  const left = d.expires_at - Date.now();
  if (left <= 0) return "expiring…";
  const s = Math.ceil(left / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

function logClass(status) {
  if (status >= 500) return "l500";
  if (status >= 400) return "l400";
  return "l200";
}

// One plain-language line per event: what happened and how it ended.
function logSummary(e) {
  const method = String(e.method ?? "").toUpperCase();
  const ms = typeof e.latencyMs === "number" ? ` in ${e.latencyMs}ms` : "";
  return `${method} ${e.path ?? "(unknown path)"} → ${e.status ?? "?"}${ms}`;
}

function logMatchesType(e, type) {
  if (type === "GET" || type === "POST" || type === "PATCH" || type === "DELETE") {
    return String(e.method ?? "").toUpperCase() === type;
  }
  const s = Number(e.status);
  if (type === "2xx") return s >= 200 && s < 300;
  if (type === "4xx") return s >= 400 && s < 500;
  if (type === "5xx") return s >= 500 && s < 600;
  return true;
}

// Collapse consecutive identical lines so a hot poll loop reads as one row:
// [x5] GET /api/deals - 2ms - id: <first correlation id>
function groupLogLines(entries) {
  const groups = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    if (last && last.method === e.method && last.path === e.path && last.status === e.status) {
      last.count += 1;
    } else {
      groups.push({ ...e, count: 1 });
    }
  }
  return groups;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

// Side drawer: row clicks land here as well as in the section detail pane,
// so the operator never loses context while scrolling a long table.
function openDrawer(title, text) {
  $("drawer-title").textContent = title;
  $("drawer-body").textContent = text;
  $("drawer").hidden = false;
}

function renderAttention(pendingCount, frozenDeals, rejectedDeals) {
  const list = $("attention-list");
  if (list === null) return;
  const items = [];
  if (pendingCount > 0) items.push({ view: "approvals", label: `${pendingCount} agent${pendingCount === 1 ? "" : "s"} awaiting review` });
  if (frozenDeals.length > 0) items.push({ view: "disputes", label: `${frozenDeals.length} frozen escrow${frozenDeals.length === 1 ? "" : "s"} (VERIFYING)` });
  if (rejectedDeals.length > 0) items.push({ view: "disputes", label: `${rejectedDeals.length} rejected deal${rejectedDeals.length === 1 ? "" : "s"} (buyer refunded)` });
  list.innerHTML = items.length === 0
    ? `<li class="empty-state">All clear — nothing needs a human.</li>`
    : items.map((i) => `<li><button class="btn btn-ghost" data-goto="${i.view}">${esc(i.label)} →</button></li>`).join("");
  for (const btn of list.querySelectorAll("[data-goto]")) {
    btn.addEventListener("click", () => showView(btn.dataset.goto));
  }
}

// Shared table controller: search, status chips, sorting, load-more, sticky
// headers (CSS), and row-click detail. One registry entry per tbody id.
const PAGE_SIZE = 25;
const tables = {};

function dealRowHTML(d) {
  return `<tr data-id="${esc(d.id)}" data-deal-id="${esc(d.id)}" data-state="${esc(d.state)}" data-price="${d.price ?? ""}" data-buyer="${esc(d.buyer ?? "")}" data-seller="${esc(d.seller ?? "")}"><td data-deal-id="${esc(d.id)}">${esc(d.id)}</td><td>${pill(d.state)}</td><td>${esc(d.buyer ?? "")}</td><td>${esc(d.seller ?? "")}</td><td data-price="${d.price ?? ""}">${d.price ?? ""}</td><td>${expiresIn(d)}</td></tr>`;
}

function auditRowHTML(e) {
  return `<tr data-action="${esc(e.action)}" data-agent-id="${esc(e.agentId)}"><td>${new Date(e.at).toLocaleTimeString()}</td><td>${esc(e.action)}</td><td data-agent-id="${esc(e.agentId)}">${esc(e.agentId)}</td><td>${esc(e.from ?? "")} → ${esc(e.to ?? "")}</td><td>${esc(e.reason ?? "")}</td></tr>`;
}

function rowText(row, fields) {
  return fields.map((f) => String(row[f] ?? "").toLowerCase()).join(" ");
}

function compareRows(key, dir) {
  return (a, b) => {
    const av = a[key] ?? "";
    const bv = b[key] ?? "";
    const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
    return dir === "desc" ? -cmp : cmp;
  };
}

function setupTable(name, cfg) {
  const tbody = $(cfg.tbody);
  if (tbody === null) return;
  tables[name] = { ...cfg, tbody, rows: [], shown: PAGE_SIZE, query: "", status: "", sortKey: cfg.defaultSort ?? "", sortDir: "asc" };
  const tools = document.querySelector(`[data-table-tools="${name}"]`);
  const card = tbody.closest(".card");
  const state = tables[name];
  state.emptyEl = card !== null ? card.querySelector('[data-role="empty"]') : null;
  state.moreBtn = card !== null ? card.querySelector('[data-role="more"]') : null;
  if (tools !== null) {
    const search = tools.querySelector('[data-role="search"]');
    if (search !== null) search.addEventListener("input", (e) => {
      state.query = e.target.value.trim().toLowerCase();
      state.shown = PAGE_SIZE;
      refreshTable(name);
    });
    const sortSel = tools.querySelector('[data-role="sort"]');
    if (sortSel !== null && Array.isArray(cfg.sorts)) {
      sortSel.innerHTML = `<option value="">Unsorted</option>` + cfg.sorts.map((s) => `<option value="${s.key}">${esc(s.label)}</option>`).join("");
      sortSel.addEventListener("change", (e) => {
        state.sortKey = e.target.value;
        state.sortDir = "asc";
        refreshTable(name);
      });
    }
  }
  const table = document.querySelector(`table[data-table="${name}"]`);
  if (table !== null) {
    for (const th of table.querySelectorAll("th[data-sort]")) {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (state.sortKey === key) {
          state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        } else {
          state.sortKey = key;
          state.sortDir = "asc";
        }
        refreshTable(name);
      });
    }
  }
  if (state.moreBtn !== null) {
    state.moreBtn.addEventListener("click", () => {
      state.shown += PAGE_SIZE;
      refreshTable(name);
    });
  }
  renderChips(name);
}

function renderChips(name) {
  const state = tables[name];
  if (state === undefined) return;
  const tools = document.querySelector(`[data-table-tools="${name}"]`);
  if (tools === null) return;
  const holder = tools.querySelector('[data-role="chips"]');
  if (holder === null) return;
  const statuses = typeof state.statuses === "function" ? state.statuses() : state.statuses;
  if (!Array.isArray(statuses) || statuses.length === 0) {
    holder.innerHTML = "";
    return;
  }
  holder.innerHTML = [`<button class="tab${state.status === "" ? " active" : ""}" data-status="">All</button>`]
    .concat(statuses.map((s) => `<button class="tab${state.status === s ? " active" : ""}" data-status="${esc(s)}">${esc(s)}</button>`))
    .join("");
  for (const btn of holder.querySelectorAll("[data-status]")) {
    btn.addEventListener("click", () => {
      state.status = btn.dataset.status;
      state.shown = PAGE_SIZE;
      renderChips(name);
      refreshTable(name);
    });
  }
}

function visibleRows(name) {
  const state = tables[name];
  let rows = state.rows;
  if (state.status !== "") rows = rows.filter((r) => String(r[state.statusField ?? "status"] ?? "") === state.status);
  if (state.query !== "") rows = rows.filter((r) => rowText(r, state.searchFields).includes(state.query));
  if (state.sortKey !== "") rows = rows.slice().sort(compareRows(state.sortKey, state.sortDir));
  return rows;
}

function refreshTable(name) {
  const state = tables[name];
  if (state === undefined) return;
  const rows = visibleRows(name);
  const slice = rows.slice(0, state.shown);
  if (name === "agents" || name === "reviews") {
    renderAgentTable(state.tbody, slice, name === "reviews");
  } else {
    state.tbody.innerHTML = slice.map(state.rowHTML).join("");
    for (const row of state.tbody.querySelectorAll("tr")) {
      row.addEventListener("click", () => state.onRow(row.dataset));
    }
  }
  if (state.emptyEl !== null) {
    if (state.emptyDefault === undefined) state.emptyDefault = state.emptyEl.textContent;
    const filtered = state.query !== "" || state.status !== "";
    state.emptyEl.hidden = rows.length !== 0;
    state.emptyEl.textContent = rows.length === 0 && filtered ? "No results found. Clear the search or reset the filters." : state.emptyDefault;
  }
  if (state.moreBtn !== null) state.moreBtn.hidden = rows.length <= state.shown;
}

function setTableRows(name, rows) {
  const state = tables[name];
  if (state === undefined) return;
  state.rows = Array.isArray(rows) ? rows : [];
  renderChips(name);
  refreshTable(name);
}

async function tick() {
  if (paused) return;
  try {
    const [dash, agentsBody, auditBody] = await Promise.all([
      fetchJSON("/api/admin/dashboard"),
      fetchJSON("/api/admin/agents"),
      fetchJSON("/api/admin/audit"),
    ]);
    const { stats, deals, logs } = dash.result;
    const agents = agentsBody.result.agents;
    const audit = auditBody.result.audit;
    $("m-active").textContent = stats.activeDeals;
    $("m-tvl").textContent = stats.tvl;
    $("m-settled").textContent = stats.settled;
    $("m-rejected").textContent = stats.rejected;
    const pendingAgents = agents.filter((a) => a.status === "PENDING");
    const frozenDeals = deals.filter((d) => d.state === "VERIFYING");
    const rejectedDeals = deals.filter((d) => d.state === "REJECTED");
    $("m-agents").textContent = agents.length;
    $("m-pending").textContent = pendingAgents.length;
    $("m-frozen").textContent = frozenDeals.reduce((sum, d) => sum + (Number.isInteger(d.price) ? d.price : 0), 0);
    renderAttention(pendingAgents.length, frozenDeals, rejectedDeals);
    $("net-dot").classList.remove("down");
    $("net-text").textContent = dash.result.demoSafe === true ? "Network Live · DEMO SAFE" : "Network Live";
    // A recovered transport rejoins the live stream and drops back to the
    // slow backup cadence.
    if (stream === null && !paused) {
      connectStream();
      if (timer !== null) clearInterval(timer);
      timer = setInterval(tick, 30000);
    }

    const q = logQuery.trim().toLowerCase();
    const typeFilter = $("log-type") !== null ? $("log-type").value : "";
    const hideSystem = $("log-hide-system") !== null ? $("log-hide-system").checked : false;
    const visible = logs
      .filter((e) => (e.at ?? 0) > clearedBefore)
      .filter((e) => !hideSystem || !String(e.path ?? "").startsWith("/api/admin"))
      .filter((e) => typeFilter === "" || logMatchesType(e, typeFilter))
      .filter(
        (e) =>
          q === "" ||
          `${e.method} ${e.path} ${e.status} ${e.correlationId ?? ""}`.toLowerCase().includes(q),
      );
    const logEl = $("log");
    const pinned = !scrollPaused && logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    logEl.innerHTML = groupLogLines(visible.slice().reverse())
      .map(
        (e) => {
          const method = String(e.method ?? "").toUpperCase();
          const mcls = method === "GET" ? "m-get" : method === "POST" ? "m-post" : "";
          return `<details class="log-line ${logClass(e.status)}" data-method="${esc(method)}" data-path="${esc(e.path)}" data-status="${e.status}"><summary>${e.count > 1 ? `[x${e.count}] ` : ""}${esc(logSummary(e))}</summary><code>${esc(JSON.stringify(e))}</code></details>`;
        },
      )
      .join("");
    if (!scrollPaused && pinned) logEl.scrollTop = logEl.scrollHeight;

    renderStateMachine(deals);

    setTableRows("deals", deals);
    setTableRows(
      "frozen",
      deals.filter((d) => d.state === "VERIFYING"),
    );
    setTableRows(
      "rejected",
      deals.filter((d) => d.state === "REJECTED"),
    );
    setTableRows(
      "ledger",
      deals.filter((d) => d.state === "ESCROW_LOCKED" || d.state === "VERIFYING" || d.state === "AGREED"),
    );
    const locked = deals.filter((d) => d.state === "ESCROW_LOCKED" || d.state === "VERIFYING");
    const lockedSum = locked.reduce((sum, d) => sum + (Number.isInteger(d.price) ? d.price : 0), 0);
    $("ledger-summary").textContent = `${locked.length} deals locking ${lockedSum} CR.`;

    setTableRows("agents", agents);
    setTableRows(
      "reviews",
      agents.filter((a) => a.status === "PENDING"),
    );
    const pending = agents.filter((a) => a.status === "PENDING").length;
    $("review-count").textContent = pending === 0 ? "" : `(${pending})`;
    if (pending === 0) $("review-detail").textContent = "Queue empty: every listing has a verdict.";

    setTableRows("audit", audit);
  } catch (err) {
    // A 401 already redirected to /login inside fetchJSON; anything else
    // reaching here is the network itself being down.
    if (err.message !== "locked") {
      $("net-dot").classList.add("down");
      $("net-text").textContent = "Network Down";
    }
  }
}

async function showDeal(id) {
  try {
    const body = await fetchJSON(`/api/deals/${encodeURIComponent(id)}`);
    setDetail("detail", body.result);
    openDrawer(`Deal ${id}`, JSON.stringify(body.result, null, 2));
  } catch (err) {
    $("detail").textContent = `Failed to load ${id}: ${err.message}`;
    openDrawer(`Deal ${id}`, `Failed to load ${id}: ${err.message}`);
  }
}

// Card-style detail panes: labeled rows instead of raw JSON. Objects and
// arrays render compactly; the drawer keeps the full JSON for copying.
function setDetail(id, obj) {
  const node = $(id);
  if (node === null) return;
  if (obj === null || obj === undefined || typeof obj !== "object") {
    node.textContent = obj ?? "—";
    return;
  }
  const rows = Object.entries(obj)
    .map(([k, v]) => {
      const val = v !== null && typeof v === "object" ? JSON.stringify(v) : v;
      return `<div class="detail-row"><dt>${esc(k)}</dt><dd>${esc(val ?? "—")}</dd></div>`;
    })
    .join("");
  node.innerHTML = `<dl class="detail-grid">${rows}</dl>`;
}

function agentActions(a) {
  // Buttons mirror the lifecycle table: only legal transitions are offered,
  // so the UI cannot propose what the server would reject. Edit and Delete
  // ride on every row regardless of status.
  const btn = (verb, label, cls) => `<button class="${cls}" data-id="${esc(a.id)}" data-verb="${verb}">${label}</button>`;
  const edit = `<button class="tab" data-edit="${esc(a.id)}">Edit</button>`;
  const del = `<button class="reject" data-delete="${esc(a.id)}">Delete</button>`;
  if (a.status === "PENDING") return `${btn("approve", "Approve", "approve")} ${btn("reject", "Reject", "reject")} ${edit} ${del}`;
  if (a.status === "ACTIVE") return `${btn("suspend", "Suspend", "suspend")} ${btn("retire", "Retire", "retire")} ${edit} ${del}`;
  if (a.status === "SUSPENDED") return `${btn("approve", "Approve", "approve")} ${edit} ${del}`;
  return `${edit} ${del}`;
}

const EDIT_CATEGORIES = ["image_gen", "video_gen", "data", "text_gen", "speech", "speech_transcription"];

function categoryOptions(selected) {
  const blank = `<option value="">— keep current —</option>`;
  return blank + EDIT_CATEGORIES.map((c) => `<option value="${c}"${c === selected ? " selected" : ""}>${esc(c)}</option>`).join("");
}

function askEdit(agent) {
  // Form modal pre-filled from the row record. Blank inputs keep the
  // current value (every field has a minimum, so blanks are dropped, not
  // sent). An all-blank submit is a no-op.
  if (agent === undefined || agent === null) return;
  openModal({
    title: `Edit ${agent.id}`,
    sub: "Submits PATCH /api/admin/agents/:id. Blank fields keep their values.",
    bodyHTML:
      `<label class="field"><span>Title (5–60 chars)</span>` +
      `<input id="f-title" maxlength="60" value="${esc(agent.title ?? "")}" /></label>` +
      `<label class="field"><span>Description (20–250 chars)</span>` +
      `<textarea id="f-desc" rows="3" maxlength="250">${esc(agent.description ?? "")}</textarea></label>` +
      `<div class="field-row">` +
      `<label class="field"><span>Price (CR, 1–100000)</span>` +
      `<input id="f-price" inputmode="numeric" value="${agent.price ?? ""}" /></label>` +
      `<label class="field"><span>Delivery SLA (seconds, 60–86400)</span>` +
      `<input id="f-sla" inputmode="numeric" value="${agent.delivery_sla_seconds ?? ""}" /></label>` +
      `</div>` +
      `<label class="field"><span>Category</span>` +
      `<select id="f-cat">${categoryOptions(agent.category ?? "")}</select></label>`,
    submitLabel: "Save changes",
    onSubmit: async () => {
      const val = (id) => document.querySelector(id).value.trim();
      const patch = {};
      const title = val("#f-title");
      const description = val("#f-desc");
      const priceRaw = val("#f-price");
      const slaRaw = val("#f-sla");
      const category = val("#f-cat");
      if (title !== "" && (title.length < 5 || title.length > 60)) return "Title must be 5–60 characters.";
      if (description !== "" && (description.length < 20 || description.length > 250)) return "Description must be 20–250 characters.";
      if (priceRaw !== "") {
        const price = Number(priceRaw);
        if (!Number.isInteger(price) || price < 1 || price > 100000) return "Price must be a whole number from 1 to 100000 CR.";
        patch.price = price;
      }
      if (slaRaw !== "") {
        const sla = Number(slaRaw);
        if (!Number.isInteger(sla) || sla < 60 || sla > 86400) return "Delivery SLA must be a whole number from 60 to 86400 seconds.";
        patch.delivery_sla_seconds = sla;
      }
      if (title !== "") patch.title = title;
      if (description !== "") patch.description = description;
      if (category !== "") patch.category = category;
      if (Object.keys(patch).length === 0) return "No changes to save.";
      try {
        await adminFetch(`/api/admin/agents/${encodeURIComponent(agent.id)}`, { method: "PATCH", body: patch });
      } catch (err) {
        return err.code === "BAD_PATCH" ? "Nothing to change: the server rejected an empty patch." : `Edit failed: ${err.code ?? err.message}`;
      }
      toast(`Saved changes to ${agent.id}.`, "success");
      tick();
      return null;
    },
  });
}

function askDelete(id) {
  // Guarded server-side too (live deals refuse with 409): the modal here
  // is courtesy, the store check is the guarantee.
  openModal({
    title: `Delete ${id}?`,
    sub: "Deals stay as history. Blocked while the agent has live deals.",
    bodyHTML: `<p>This permanently removes the agent and its listings.</p>`,
    submitLabel: "Delete",
    danger: true,
    onSubmit: async () => {
      try {
        await adminFetch(`/api/admin/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
      } catch (err) {
        return `Delete failed: ${err.code ?? err.message}`;
      }
      toast(`Deleted agent ${id}.`, "success");
      tick();
      return null;
    },
  });
}

function renderAgentTable(tbody, rows, isQueue) {
  tbody.innerHTML = rows
    .map(
      (a) =>
        `<tr data-id="${esc(a.id)}" data-agent-id="${esc(a.id)}" data-status="${esc(a.status)}" data-price="${a.price ?? ""}"><td data-agent-id="${esc(a.id)}">${esc(a.id)}</td><td>${esc(a.title ?? a.id)}</td><td>${statusPill(a.status)}</td><td data-price="${a.price ?? ""}">${a.price ?? ""}</td><td>${agentActions(a)}</td></tr>`,
    )
    .join("");
  for (const row of tbody.querySelectorAll("tr")) {
    row.addEventListener("click", () => {
      const found = rows.find((x) => x.id === row.dataset.id) ?? null;
      setDetail(isQueue ? "review-detail" : "agent-detail", found);
      openDrawer(`Agent ${row.dataset.id}`, JSON.stringify(found, null, 2));
    });
  }
  for (const btn of tbody.querySelectorAll("button[data-verb]")) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      askModeration(btn.dataset.id, btn.dataset.verb);
    });
  }
  for (const btn of tbody.querySelectorAll("button[data-edit]")) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      askEdit(rows.find((x) => x.id === btn.dataset.edit) ?? null);
    });
  }
  for (const btn of tbody.querySelectorAll("button[data-delete]")) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      askDelete(btn.dataset.delete);
    });
  }
}

const VERB_LABEL = { approve: "Approve", reject: "Reject", suspend: "Suspend", retire: "Retire" };

function askModeration(id, verb) {
  // Approve re-activates without a note; everything destructive or
  // terminal requires a written reason the agent can see.
  const label = VERB_LABEL[verb] ?? verb;
  const needsReason = verb !== "approve";
  openModal({
    title: `${label} agent`,
    sub: `${verb} ${id}?${needsReason ? " The reason is shown to the agent." : ""}`,
    bodyHTML: needsReason
      ? `<label class="field"><span>Reason (shown to the agent)</span>` +
        `<textarea id="f-reason" rows="3" placeholder="Reason (shown to the agent)"></textarea></label>`
      : `<p>${label} proceeds immediately. No reason is required.</p>`,
    submitLabel: label,
    danger: verb === "reject" || verb === "retire",
    onSubmit: async () => {
      const ta = document.querySelector("#f-reason");
      const note = ta === null ? "" : ta.value.trim();
      if (needsReason && note === "") return "A reason is required.";
      try {
        await decide(id, verb, note === "" ? undefined : note);
      } catch (err) {
        return `${label} failed: ${err.code ?? err.message}`;
      }
      return null;
    },
  });
}

async function decide(id, verb, note) {
  // Fresh key per click: replaying the same key would return the first
  // verdict instead of recording this one.
  const field = verb === "approve" ? "message" : "reason";
  await adminFetch(`/api/admin/agents/${encodeURIComponent(id)}/${verb.toLowerCase()}`, {
    method: "POST",
    body: note === undefined ? {} : { [field]: note },
    idempotency: true,
  });
  toast(`${VERB_LABEL[verb] ?? verb}d agent ${id}.`, "success");
  tick();
}

const VIEWS = ["overview", "approvals", "deals", "disputes", "ledger", "events", "settings"];

function showView(name) {
  for (const v of VIEWS) {
    document.querySelector(`.navlink[data-view="${v}"]`).classList.toggle("active", v === name);
    $(`view-${v}`).hidden = v !== name;
  }
}

for (const link of document.querySelectorAll(".navlink")) {
  link.addEventListener("click", () => showView(link.dataset.view));
}

const DEAL_SORTS = [
  { key: "id", label: "Deal ID" },
  { key: "state", label: "State" },
  { key: "buyer", label: "Buyer" },
  { key: "seller", label: "Seller" },
  { key: "price", label: "Price" },
];
const DEAL_SEARCH = ["id", "buyer", "seller", "state"];
const DEAL_STATUSES = ["NEGOTIATING", "AGREED", "ESCROW_LOCKED", "EXECUTING", "DELIVERED", "VERIFYING", "SETTLED", "REJECTED"];
const AGENT_SEARCH = ["id", "title", "status", "role"];
const AGENT_STATUSES = ["PENDING", "ACTIVE", "SUSPENDED", "RETIRED"];

setupTable("deals", {
  tbody: "deals",
  rowHTML: dealRowHTML,
  onRow: (ds) => showDeal(ds.id),
  searchFields: DEAL_SEARCH,
  statuses: DEAL_STATUSES,
  statusField: "state",
  sorts: DEAL_SORTS,
});
setupTable("frozen", {
  tbody: "frozen",
  rowHTML: dealRowHTML,
  onRow: (ds) => showDeal(ds.id),
  searchFields: DEAL_SEARCH,
  statuses: [],
});
setupTable("rejected", {
  tbody: "rejected",
  rowHTML: dealRowHTML,
  onRow: (ds) => showDeal(ds.id),
  searchFields: DEAL_SEARCH,
  statuses: [],
});
setupTable("ledger", {
  tbody: "ledger",
  rowHTML: dealRowHTML,
  onRow: (ds) => showDeal(ds.id),
  searchFields: DEAL_SEARCH,
  statuses: ["AGREED", "ESCROW_LOCKED", "VERIFYING"],
  statusField: "state",
});
setupTable("agents", {
  tbody: "agents",
  searchFields: AGENT_SEARCH,
  statuses: AGENT_STATUSES,
  sorts: [
    { key: "id", label: "Agent ID" },
    { key: "title", label: "Title" },
    { key: "status", label: "Status" },
    { key: "price", label: "Price" },
  ],
});
setupTable("reviews", {
  tbody: "reviews",
  searchFields: AGENT_SEARCH,
  statuses: [],
});
setupTable("audit", {
  tbody: "audit",
  rowHTML: auditRowHTML,
  onRow: (ds) => openDrawer(`Audit ${ds.action} ${ds.agentId}`, JSON.stringify(ds, null, 2)),
  searchFields: ["action", "agentId", "reason"],
  statuses: () => [...new Set((tables.audit?.rows ?? []).map((e) => e.action))],
  statusField: "action",
  sorts: [
    { key: "at", label: "Time" },
    { key: "action", label: "Action" },
    { key: "agentId", label: "Agent" },
  ],
});

$("drawer-close").addEventListener("click", () => {
  $("drawer").hidden = true;
});

// Density toggle: comfortable default, compact for dense ops. Persisted.
function setDensity(mode) {
  document.body.dataset.density = mode === "compact" ? "compact" : "comfortable";
  try {
    localStorage.setItem("bazaar-density", document.body.dataset.density);
  } catch { /* private mode: session-only */ }
  for (const btn of document.querySelectorAll("[data-density]")) {
    btn.classList.toggle("active", btn.dataset.density === document.body.dataset.density);
  }
}
for (const btn of document.querySelectorAll("[data-density]")) {
  btn.addEventListener("click", () => setDensity(btn.dataset.density));
}
try {
  setDensity(localStorage.getItem("bazaar-density") ?? "comfortable");
} catch {
  setDensity("comfortable");
}

$("log-type").addEventListener("change", () => tick());
$("log-hide-system").addEventListener("change", () => tick());

$("logout").addEventListener("click", () => {
  localStorage.removeItem(SECRET_KEY);
  location.href = "/login";
});

$("log-search").addEventListener("input", (e) => {
  logQuery = e.target.value;
});
$("log-pause").addEventListener("click", () => {
  scrollPaused = !scrollPaused;
  $("log-pause").textContent = scrollPaused ? "Resume Scroll" : "Pause Scroll";
});
$("log-clear").addEventListener("click", () => {
  clearedBefore = Date.now();
  $("log").innerHTML = "";
});

$("pause").addEventListener("click", () => {
  paused = !paused;
  $("pause").textContent = paused ? "Resume Protocol" : "Pause Protocol";
  $("paused-note").textContent = paused ? "Polling paused; the protocol keeps running." : "";
  // Operator decision aid only: the protocol itself is unaffected.
  toast(paused ? "Console polling paused." : "Console polling resumed.", "info");
});

tick();
connectStream();
// Slow backup cadence: the stream is primary, this only heals silence.
// The error path drops to 2 s polling until a tick reconnects the stream.
timer = setInterval(tick, 30000);
