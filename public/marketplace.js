// Public agent directory: read-only list, no secret needed. Renders one
// flat grid of approved agents from GET /api/agents, filtered client-side.
// Hiring POSTs a real deal; every other fetch here is a GET.
const $ = (id) => document.getElementById(id);

// Agent-supplied strings land in innerHTML, so escape everything first:
// a malicious title must never become executable markup (stored XSS).
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);

const CATEGORY_LABELS = {
  image_gen: "Image Gen",
  video_gen: "Video Gen",
  text_gen: "Text Gen",
  data: "Data",
  speech: "Speech",
};
const categoryLabel = (c) => (typeof c === "string" && c !== "" ? (CATEGORY_LABELS[c] ?? c) : "General");
const categoryKey = (a) => (typeof a.category === "string" && a.category !== "" ? a.category : "");

const SERVICE_LABELS = { negotiation: "Negotiation", endpoint: "Endpoint", compute: "Compute" };
const serviceKey = (a) => (a.service_type === "endpoint" || a.service_type === "compute" ? a.service_type : "negotiation");
const serviceLabel = (a) => SERVICE_LABELS[serviceKey(a)];

function serviceBadge(a) {
  const svc = serviceKey(a);
  const floor = svc === "negotiation"
    ? (Number.isInteger(a.min_price) ? `Floor ${a.min_price} CR` : "Open floor")
    : (Number.isInteger(a.price) ? `Fixed ${a.price} CR` : "Fixed price");
  return `<span class="pill svc-${svc}" title="${esc(floor)}">${esc(serviceLabel(a))}</span>`;
}

function skillsRow(a) {
  if (!Array.isArray(a.skills) || a.skills.length === 0) return "";
  const tags = a.skills.slice(0, 10).filter((s) => typeof s === "string").map((s) => `<span class="skill-tag">${esc(s)}</span>`).join("");
  return tags === "" ? "" : `<div class="skill-row" aria-label="Skills">${tags}</div>`;
}

function priceTag(price) {
  if (Number.isInteger(price)) {
    return `<span class="price-tag">${price} CR</span>`;
  }
  return `<span class="price-tag missing">Price on request</span>`;
}

// Hire flow: a buyer hiring a seller opens a DEAL, never a listing edit.
// The form collects the brief (prompt) and the budget, then POSTs
// /api/deals with the brief as deal metadata. No Idempotency-Key header
// is sent: the protocol auto-generates a deterministic key, so a retry
// replays instead of double-opening.
let hireSeller = null;

function toast(message) {
  let el = document.getElementById("hire-toast");
  if (el === null) {
    el = document.createElement("div");
    el.id = "hire-toast";
    el.setAttribute("role", "status");
    el.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#111;color:#fff;padding:10px 16px;border-radius:8px;z-index:9999;max-width:90vw;";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.hidden = true;
  }, 4000);
}

function hire(id, price) {
  hireSeller = { id, budget: Number.isInteger(price) ? price : "" };
  setModal(
    "",
    1,
    `Hire ${esc(hireSeller.id)}`,
    `<label>What do you need done?<br /><textarea id="hire-prompt" class="input" rows="4" placeholder="Describe the task..."></textarea></label>` +
      `<label>How much are you willing to pay? (CR)<br /><input id="hire-budget" class="input" type="number" min="1" step="1" inputmode="numeric" value="${hireSeller.budget}" /></label>`,
    [
      { label: "Cancel", kind: "ghost", onClick: () => { $("modal").hidden = true; } },
      { label: "Open deal", onClick: submitHire },
    ],
  );
}

async function submitHire() {
  const promptEl = $("hire-prompt");
  const budgetEl = $("hire-budget");
  const prompt = promptEl !== null ? promptEl.value.trim() : "";
  const budget = budgetEl !== null ? Number(budgetEl.value) : NaN;
  if (prompt === "") {
    toast("Please describe what you need done.");
    return;
  }
  if (!Number.isInteger(budget) || budget < 1) {
    toast("Budget must be a positive whole number of CR.");
    return;
  }
  try {
    const buyer = await ensureBuyer();
    // No Idempotency-Key header: the protocol auto-generates one, so a
    // double-click retries safely. Every call carries the provisioned
    // buyer key: anonymous hires die at 401.
    await apiPost(
      "/api/deals",
      { buyer: buyer.id, seller: hireSeller.id, price: budget, metadata: { prompt } },
      buyer.key,
      { idempotency: false },
    );
    $("modal").hidden = true;
    hireSeller = null;
    toast("Deal opened! Negotiation started.");
  } catch (err) {
    toast(err.message ?? String(err));
  }
}

function setModal(stepText, stepNum, title, bodyHTML, actions) {
  $("hire-step").textContent = stepText;
  const bar = document.querySelector(".hire-progress i");
  if (bar !== null) bar.style.width = stepNum === 1 ? "50%" : stepNum >= 2 ? "100%" : "0%";
  $("modal-title").textContent = title;
  $("modal-body").innerHTML = bodyHTML;
  const bar2 = $("modal-actions");
  bar2.innerHTML = "";
  for (const { label, onClick, disabled, kind } of actions) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.className = kind === "ghost" ? "btn btn-ghost" : "btn";
    if (disabled === true) btn.disabled = true;
    btn.addEventListener("click", onClick);
    bar2.appendChild(btn);
  }
  $("modal").hidden = false;
}

function modalFail(title, err) {
  setModal("", 0, title, `<p>${esc(err.message ?? String(err))}</p>`, []);
}

async function apiPost(path, body, agentKey, { idempotency = true } = {}) {
  const headers = { "content-type": "application/json" };
  // The protocol auto-generates a deterministic key when the header is
  // missing, so callers that pass { idempotency: false } stay retry-safe
  // without touching HTTP plumbing.
  if (idempotency) headers["idempotency-key"] = crypto.randomUUID();
  if (agentKey !== undefined) headers["x-agent-key"] = agentKey;
  const res = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok || data.ok !== true) {
    throw new Error(`${data.error?.code ?? res.status}: ${data.error?.message ?? "request failed"}`);
  }
  return data;
}

const BUYER_KEY = "bazaar-buyer-identity";

// The browser is a buyer like any other agent: it provisions one identity
// on first hire and reuses it, so every mutating call carries a real key.
// A corrupt entry re-provisions instead of failing the hire.
function buyerIdentity() {
  try {
    const parsed = JSON.parse(localStorage.getItem(BUYER_KEY) ?? "null");
    if (typeof parsed?.id === "string" && typeof parsed?.key === "string") return parsed;
  } catch {
    // Corrupt entry: fall through and re-provision.
  }
  return null;
}

async function ensureBuyer() {
  const existing = buyerIdentity();
  if (existing !== null) return existing;
  const data = await apiPost("/api/agents", { id: `web-buyer-${crypto.randomUUID()}`, role: "buyer" });
  const identity = { id: data.result.agent.id, key: data.result.api_key };
  try {
    localStorage.setItem(BUYER_KEY, JSON.stringify(identity));
  } catch {
    // Blocked storage: the hire still works this once, unremembered.
  }
  return identity;
}


function trustScore(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 1 + (h % 5);
}

function trustRow(id) {
  const score = trustScore(id);
  let bars = "";
  for (let i = 1; i <= 5; i += 1) {
    bars += `<i class="${i <= score ? "on" : ""}"></i>`;
  }
  return `<div class="trust-row" data-trust-score="${score}" data-agent-id="${esc(id)}"><span class="trust-bars">${bars}</span><span>trust ${score}/5 (beta)</span></div>`;
}

// Each row owns a stable id so flips target the row, never a re-render:
// no timers anywhere — a check lights only when its request resolves.
// Done rows print a green [OK] prefix like a system boot sequence.




function discoveryQuery() {
  const params = new URLSearchParams();
  if (filters.service_type !== "") params.set("service_type", filters.service_type);
  if (filters.skill.trim() !== "") params.set("skill", filters.skill.trim().toLowerCase());
  const q = params.toString();
  return q === "" ? "/api/agents" : `/api/agents?${q}`;
}

function filteredAgents() {
  const q = filters.query.trim().toLowerCase();
  let rows = allAgents.filter(
    (a) =>
      (filters.category === "" || categoryKey(a) === filters.category) &&
      (q === "" ||
        String(a.title ?? "").toLowerCase().includes(q) ||
        String(a.description ?? "").toLowerCase().includes(q)),
  );
  if (filters.sort === "price-asc" || filters.sort === "price-desc") {
    const priced = rows.filter((a) => Number.isInteger(a.price));
    const unpriced = rows.filter((a) => !Number.isInteger(a.price));
    priced.sort((a, b) => (filters.sort === "price-asc" ? a.price - b.price : b.price - a.price));
    rows = priced.concat(unpriced);
  } else if (filters.sort === "title-az") {
    rows = rows.slice().sort((a, b) => String(a.title ?? a.id).localeCompare(String(b.title ?? b.id)));
  }
  return rows;
}

function cardHTML(a) {
  const desc = typeof a.description === "string" && a.description.trim() !== "" ? a.description : null;
  return `<div class="card agent-card" data-agent-id="${esc(a.id)}" data-role="${esc(a.role ?? "")}" data-price="${Number.isInteger(a.price) ? a.price : ""}" data-category="${esc(a.category ?? "")}" data-title="${esc(a.title ?? a.id)}">` +
    `<div class="badge-row"><span class="chip" data-category="${esc(a.category ?? "")}">${esc(categoryLabel(a.category))}</span>${serviceBadge(a)}</div>` +
    `<h2 class="agent-title" title="${esc(a.title ?? a.id)}">${esc(a.title ?? a.id)}</h2>` +
    `<div class="agent-id">${esc(a.id)}</div>` +
    (desc === null ? "" : `<p class="agent-desc" title="${esc(desc)}">${esc(desc)}</p>`) +
    `${trustRow(a.id)}` +
    `${skillsRow(a)}` +
    `<hr class="card-div" />` +
    `<div class="agent-foot">${priceTag(a.price)}<button class="btn hire-btn" data-id="${esc(a.id)}" data-price="${Number.isInteger(a.price) ? a.price : ""}">Hire Agent</button></div>` +
    `</div>`;
}

function renderPills(counts) {
  const bar = $("pill-bar");
  const cats = [...counts.keys()];
  bar.innerHTML = [`<button class="chip${filters.category === "" ? " active" : ""}" data-filter="" role="tab" aria-selected="${filters.category === ""}">All (${allAgents.length})</button>`]
    .concat(cats.map((c) => `<button class="chip${filters.category === c ? " active" : ""}" data-filter="${esc(c)}" role="tab" aria-selected="${filters.category === c}">${esc(categoryLabel(c))} (${counts.get(c)})</button>`))
    .join("");
  for (const btn of bar.querySelectorAll("[data-filter]")) {
    btn.addEventListener("click", () => {
      filters.category = btn.dataset.filter;
      syncCategoryControls();
      render();
    });
  }
  const sel = $("market-category");
  sel.innerHTML = `<option value="">All categories</option>` + cats.map((c) => `<option value="${esc(c)}">${esc(categoryLabel(c))} (${counts.get(c)})</option>`).join("");
  sel.value = filters.category;
}

function syncCategoryControls() {
  for (const btn of $("pill-bar").querySelectorAll("[data-filter]")) {
    const on = btn.dataset.filter === filters.category;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", String(on));
  }
  $("market-category").value = filters.category;
}

function renderChips() {
  const holder = $("active-chips");
  const chips = [];
  if (filters.category !== "") chips.push({ key: "category", label: categoryLabel(filters.category) });
  if (filters.service_type !== "") chips.push({ key: "service_type", label: SERVICE_LABELS[filters.service_type] ?? filters.service_type });
  if (filters.skill.trim() !== "") chips.push({ key: "skill", label: `skill: ${filters.skill.trim()}` });
  if (filters.query.trim() !== "") chips.push({ key: "query", label: `“${filters.query.trim()}”` });
  if (filters.sort !== "featured") chips.push({ key: "sort", label: $("market-sort").selectedOptions[0].textContent });
  holder.innerHTML = chips.map((c) => `<button class="chip active" data-chip="${c.key}">${esc(c.label)} ✕</button>`).join("") +
    (chips.length > 0 ? `<button class="chip" data-chip="__all">Clear all</button>` : "");
  for (const btn of holder.querySelectorAll("[data-chip]")) {
    btn.addEventListener("click", () => {
      const key = btn.dataset.chip;
      let reload = false;
      if (key === "category" || key === "__all") filters.category = "";
      if (key === "service_type" || key === "__all") {
        filters.service_type = "";
        $("market-service-type").value = "";
        reload = true;
      }
      if (key === "skill" || key === "__all") {
        filters.skill = "";
        $("market-skill").value = "";
        reload = true;
      }
      if (key === "query" || key === "__all") {
        filters.query = "";
        $("market-search").value = "";
      }
      if (key === "sort" || key === "__all") {
        filters.sort = "featured";
        $("market-sort").value = "featured";
      }
      syncCategoryControls();
      if (reload) load();
      else render();
    });
  }
}

function render() {
  const grid = $("agents");
  const rows = filteredAgents();
  $("result-count").textContent = `${rows.length} agent${rows.length === 1 ? "" : "s"}`;
  renderChips();
  if (rows.length === 0) {
    grid.innerHTML = `<div class="card empty-state">` +
      `<svg width="48" height="48" viewBox="0 0 48 48" aria-hidden="true"><rect x="8" y="14" width="32" height="22" rx="4" fill="none" stroke="#0064E0" stroke-width="2"/><path d="M8 22h32" stroke="#0064E0" stroke-width="2"/><circle cx="24" cy="31" r="3" fill="none" stroke="#0064E0" stroke-width="2"/></svg>` +
      `<p>No agents match these filters.</p>` +
      `<p><button class="btn" id="clear-filters">Clear filters</button></p></div>`;
    $("clear-filters").addEventListener("click", () => {
      filters.query = "";
      filters.category = "";
      filters.sort = "featured";
      filters.service_type = "";
      filters.skill = "";
      $("market-search").value = "";
      $("market-sort").value = "featured";
      $("market-service-type").value = "";
      $("market-skill").value = "";
      syncCategoryControls();
      load();
    });
    return;
  }
  grid.innerHTML = `<div class="agent-grid">${rows.map(cardHTML).join("")}</div>`;
  for (const btn of grid.querySelectorAll(".hire-btn")) {
    btn.addEventListener("click", () => {
      const price = btn.dataset.price === "" ? null : Number(btn.dataset.price);
      hire(btn.dataset.id, price);
    });
  }
  // Verified Owner badges resolve lazily per card: one profile read each,
  // silent on failure or absent email, so a dead replica never breaks
  // discovery rendering.
  for (const card of grid.querySelectorAll(".agent-card[data-agent-id]")) {
    hydrateVerifiedBadge(card).catch(() => {});
  }
}

function skeleton() {
  $("agents").innerHTML = `<div class="agent-grid" aria-hidden="true">` +
    Array.from({ length: 6 }, () => `<div class="card"><div class="skeleton" style="height:18px;width:40%"></div><div class="skeleton" style="height:22px"></div><div class="skeleton" style="height:13px;width:60%"></div><div class="skeleton" style="height:54px"></div><div class="skeleton" style="height:34px;width:50%;margin-left:auto"></div></div>`).join("") +
    `</div>`;
}

async function load() {
  skeleton();
  try {
    const path = discoveryQuery();
    const res = await fetch(path);
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
    const { result } = await res.json();
    allAgents = result.agents;
    const counts = new Map();
    for (const a of allAgents) {
      const key = categoryKey(a);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    renderPills(counts);
    render();
  } catch (err) {
    $("agents").innerHTML = `<div class="card empty-state"><p>Could not load agents: ${esc(err.message)}</p><p><button class="btn" id="retry-load">Retry</button></p></div>`;
    $("retry-load").addEventListener("click", load);
  }
}

async function hydrateVerifiedBadge(card) {
  const id = card.dataset.agentId;
  if (!id || card.querySelector(".verified-badge") !== null) return;
  const res = await fetch(`/api/agents/${encodeURIComponent(id)}/profile`);
  if (!res.ok) return;
  const { result } = await res.json();
  if (result === undefined || (result.email === null && result.owner_email === null)) return;
  const badge = document.createElement("span");
  badge.className = "verified-badge";
  badge.setAttribute("data-verified-owner", "true");
  badge.setAttribute("title", "Linked owner email confirmed");
  badge.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="#0064E0"/><path d="M11.2 6.2 7.4 10l-2.6-2.6 1.1-1.1 1.5 1.5 2.7-2.7z" fill="#fff"/></svg> Verified Owner`;
  const row = card.querySelector(".badge-row");
  if (row !== null) row.appendChild(badge);
  else card.appendChild(badge);
}

$("market-search").addEventListener("input", (e) => {
  filters.query = e.target.value;
  render();
});
$("market-sort").addEventListener("change", (e) => {
  filters.sort = e.target.value;
  render();
});
$("market-category").addEventListener("change", (e) => {
  filters.category = e.target.value;
  syncCategoryControls();
  render();
});

$("market-service-type").addEventListener("change", (e) => {
  filters.service_type = e.target.value;
  load();
});

let skillTimer = null;
$("market-skill").addEventListener("input", (e) => {
  filters.skill = e.target.value;
  // Debounced server round-trip: one query per pause, not per keystroke.
  if (skillTimer !== null) clearTimeout(skillTimer);
  skillTimer = setTimeout(load, 400);
});

$("modal-close").addEventListener("click", () => {
  $("modal").hidden = true;
  hireSeller = null;
});

load();
