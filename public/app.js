// Founder's Control Station: polls GET /api/admin/dashboard every 2
// seconds for metrics, deals, and traffic, plus the agent directory and
// audit log. Reads are keyless except the admin subtree, which needs the
// Bearer secret. Only moderation POSTs, each with a fresh Idempotency-Key.

const $ = (id) => document.getElementById(id);
const SECRET_KEY = "bazaar-admin-secret";
let paused = false;
let timer = null;
let scrollPaused = false;
let clearedBefore = 0;
let logQuery = "";

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
  const res = await fetch(path, { headers: { authorization: `Bearer ${secret()}` } });
  if (res.status === 401) {
    localStorage.removeItem(SECRET_KEY);
    location.href = "/login";
    throw new Error("locked");
  }
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

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
    $("net-dot").classList.remove("down");
    $("net-text").textContent = "Network Live";

    const q = logQuery.trim().toLowerCase();
    const visible = logs
      .filter((e) => (e.at ?? 0) > clearedBefore)
      .filter(
        (e) =>
          q === "" ||
          `${e.method} ${e.path} ${e.status}`.toLowerCase().includes(q),
      );
    const logEl = $("log");
    const pinned = !scrollPaused && logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    logEl.innerHTML = groupLogLines(visible.slice().reverse())
      .map(
        (e) => {
          const method = String(e.method ?? "").toUpperCase();
          const mcls = method === "GET" ? "m-get" : method === "POST" ? "m-post" : "";
          return `<div class="${logClass(e.status)}" data-method="${esc(method)}" data-path="${esc(e.path)}" data-status="${e.status}">${e.count > 1 ? `[x${e.count}] ` : ""}[${e.status}] <span class="${mcls}">${esc(method)}</span> ${esc(e.path)} - ${e.latencyMs}ms - id: ${esc(e.correlationId)}</div>`;
        },
      )
      .join("");
    if (!scrollPaused && pinned) logEl.scrollTop = logEl.scrollHeight;

    renderStateMachine(deals);

    $("deals").innerHTML = deals
      .map(
        (d) =>
          `<tr data-id="${esc(d.id)}" data-deal-id="${esc(d.id)}" data-state="${esc(d.state)}" data-price="${d.price ?? ""}" data-buyer="${esc(d.buyer ?? "")}" data-seller="${esc(d.seller ?? "")}"><td data-deal-id="${esc(d.id)}">${esc(d.id)}</td><td>${pill(d.state)}</td><td>${esc(d.buyer ?? "")}</td><td>${esc(d.seller ?? "")}</td><td data-price="${d.price ?? ""}">${d.price ?? ""}</td><td>${expiresIn(d)}</td></tr>`,
      )
      .join("");
    for (const row of document.querySelectorAll("#deals tr")) {
      row.addEventListener("click", () => showDeal(row.dataset.id));
    }

    renderAgentTable($("agents"), agents, false);
    renderAgentTable(
      $("reviews"),
      agents.filter((a) => a.status === "PENDING"),
      true,
    );
    const pending = agents.filter((a) => a.status === "PENDING").length;
    $("review-count").textContent = pending === 0 ? "" : `(${pending})`;
    if (pending === 0) $("review-detail").textContent = "Queue empty: every listing has a verdict.";

    $("audit").innerHTML = audit
      .map(
        (e) =>
          `<tr data-action="${esc(e.action)}" data-agent-id="${esc(e.agentId)}"><td>${new Date(e.at).toLocaleTimeString()}</td><td>${esc(e.action)}</td><td data-agent-id="${esc(e.agentId)}">${esc(e.agentId)}</td><td>${esc(e.from ?? "")} → ${esc(e.to ?? "")}</td><td>${esc(e.reason ?? "")}</td></tr>`,
      )
      .join("");
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
    $("detail").textContent = JSON.stringify(body.result, null, 2);
  } catch (err) {
    $("detail").textContent = `Failed to load ${id}: ${err.message}`;
  }
}

function agentActions(a) {
  // Buttons mirror the lifecycle table: only legal transitions are offered,
  // so the UI cannot propose what the server would reject.
  const btn = (verb, label, cls) => `<button class="${cls}" data-id="${esc(a.id)}" data-verb="${verb}">${label}</button>`;
  if (a.status === "PENDING") return `${btn("approve", "Approve", "approve")} ${btn("reject", "Reject", "reject")}`;
  if (a.status === "ACTIVE") return `${btn("suspend", "Suspend", "suspend")} ${btn("retire", "Retire", "retire")}`;
  if (a.status === "SUSPENDED") return btn("approve", "Approve", "approve");
  return "—";
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
      const found = rows.find((x) => x.id === row.dataset.id);
      $(isQueue ? "review-detail" : "agent-detail").textContent = JSON.stringify(found, null, 2);
    });
  }
  for (const btn of tbody.querySelectorAll("button[data-verb]")) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      askModeration(btn.dataset.id, btn.dataset.verb);
    });
  }
}

let modalAction = null;

function askModeration(id, verb) {
  // Approve re-activates without a note; everything destructive or
  // terminal requires a written reason the agent can see.
  const needsReason = verb !== "approve";
  modalAction = { id, verb, needsReason };
  $("modal-title").textContent = `${verb[0] + verb.slice(1).toLowerCase()} agent`;
  $("modal-agent").textContent = `${verb} ${id}?${needsReason ? " The reason is shown to the agent." : ""}`;
  $("modal-reason").style.display = needsReason ? "" : "none";
  $("modal-reason").value = "";
  $("modal-confirm").textContent = verb[0] + verb.slice(1).toLowerCase();
  $("modal").hidden = false;
}

async function decide(id, verb, note) {
  try {
    // Fresh key per click: replaying the same key would return the first
    // verdict instead of recording this one.
    const field = verb === "approve" ? "message" : "reason";
    const res = await fetch(`/api/admin/agents/${encodeURIComponent(id)}/${verb.toLowerCase()}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret()}`,
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify(note === undefined ? {} : { [field]: note }),
    });
    if (res.status === 401) {
      localStorage.removeItem(SECRET_KEY);
      location.href = "/login";
      return;
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`${verb} failed: ${err.error?.code ?? res.status}`);
    }
    tick();
  } catch (err) {
    $("agent-detail").textContent = `Decision failed for ${id}: ${err.message}`;
  }
}

function showView(name) {
  for (const v of ["dashboard", "registry", "reviews", "audit"]) {
    document.querySelector(`.navlink[data-view="${v}"]`).classList.toggle("active", v === name);
    $(`view-${v}`).hidden = v !== name;
  }
}

for (const link of document.querySelectorAll(".navlink")) {
  link.addEventListener("click", () => showView(link.dataset.view));
}
$("modal-cancel").addEventListener("click", () => {
  $("modal").hidden = true;
  modalAction = null;
});
$("modal-confirm").addEventListener("click", () => {
  $("modal").hidden = true;
  if (modalAction === null) return;
  const note = $("modal-reason").value.trim();
  if (modalAction.needsReason && note === "") {
    $("agent-detail").textContent = "A reason is required.";
    modalAction = null;
    return;
  }
  const { id, verb } = modalAction;
  modalAction = null;
  decide(id, verb, note === "" ? undefined : note);
});

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
  alert(paused ? "Console polling paused." : "Console polling resumed.");
});

tick();
timer = setInterval(tick, 2000);
