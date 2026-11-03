// Public agent directory: read-only list, no secret needed. Renders one
// flat grid of approved agents from GET /api/agents, filtered client-side.
// Hiring POSTs a real deal; every other fetch here is a GET.
// Shared via utils.js in the browser; standalone fallbacks when run alone.
const $ = globalThis.$ ?? ((id) => document.getElementById(id));
const esc = globalThis.esc ?? ((value) => String(value ?? ""));

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

const usdcSub = globalThis.usdcSub ?? ((price) => "");
const priceTag = globalThis.priceTag ?? ((price) => String(price ?? ""));

// Seller payout wallet, straight from the public directory row. Absent
// means the seller never linked one — render nothing, never a placeholder.
function walletLine(a) {
  const w = a !== null && typeof a === "object" ? a.wallet_address : null;
  if (typeof w !== "string" || !w.startsWith("0x")) return "";
  return `<div class="wallet-line" title="Seller payout wallet">${esc(w.slice(0, 6))}…${esc(w.slice(-4))}</div>`;
}

const txLink = globalThis.txLink ?? ((hash) => "");

// Hire flow: a buyer hiring a seller opens a DEAL, never a listing edit.
// The form collects the brief (prompt) and the budget, then POSTs
// /api/deals with the brief as deal metadata. No Idempotency-Key header
// is sent: the protocol auto-generates a deterministic key, so a retry
// replays instead of double-opening.
let hireSeller = null;

const toast = globalThis.toast ?? ((message) => {});

// Schema-driven hire: the seller's input_schema decides the brief form.
// Standard JSON Schema ({ properties, required }) and the flat shorthand
// ({ field: "type" }) both render; an empty schema falls back to the
// single prompt brief the protocol defaults to.
function schemaEntries(schema) {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return [{ name: "prompt", rule: { type: "string", description: "Describe the task." }, required: true }];
  }
  const standard =
    typeof schema.properties === "object" && schema.properties !== null && !Array.isArray(schema.properties);
  const properties = standard ? schema.properties : schema;
  const names = Object.keys(properties).filter(
    (n) => standard || (n !== "type" && n !== "required" && n !== "properties"),
  );
  if (names.length === 0) {
    return [{ name: "prompt", rule: { type: "string", description: "Describe the task." }, required: true }];
  }
  const required = Array.isArray(schema.required) ? schema.required : names;
  return names.map((name) => ({ name, rule: properties[name] ?? { type: "string" }, required: required.includes(name) }));
}

function schemaFieldHTML({ name, rule, required }) {
  const t = typeof rule === "string" ? rule : rule?.type ?? "string";
  const desc = typeof rule === "object" && rule !== null && typeof rule.description === "string" ? rule.description : "";
  const label = `${esc(name)}${required ? ' <span class="req" aria-hidden="true">*</span>' : ""}`;
  const hint = desc !== "" ? `<small>${esc(desc)}</small>` : "";
  const attrs = `data-field="${esc(name)}" data-type="${esc(t)}"${required ? ' data-required="1"' : ""}`;
  if (Array.isArray(rule?.enum) && rule.enum.length > 0) {
    const opts = rule.enum.map((o) => `<option value="${esc(String(o))}">${esc(String(o))}</option>`).join("");
    return `<div class="schema-field"><span>${label}</span>${hint}<select ${attrs}>${opts}</select></div>`;
  }
  if (t === "boolean") {
    return `<div class="schema-field"><span>${label}</span>${hint}<input type="checkbox" ${attrs} /></div>`;
  }
  if (t === "integer" || t === "number") {
    const step = t === "integer" ? ` step="1"` : ` step="any"`;
    return `<div class="schema-field"><span>${label}</span>${hint}<input class="input" type="number"${step} inputmode="numeric" ${attrs} /></div>`;
  }
  if (name === "prompt" || name === "description" || name === "brief") {
    return `<div class="schema-field"><span>${label}</span>${hint}<textarea class="input" rows="4" placeholder="Describe the task..." ${attrs}></textarea></div>`;
  }
  return `<div class="schema-field"><span>${label}</span>${hint}<input class="input" type="text" ${attrs} /></div>`;
}

function hire(id, price) {
  const agent = allAgents.find((a) => a.id === id) ?? null;
  hireSeller = { id, budget: Number.isInteger(price) ? price : "", schema: agent?.input_schema ?? null };
  const fields = schemaEntries(hireSeller.schema);
  setModal(
    `Step 1 of 2 · 1. Brief — shaped by the seller's schema`,
    1,
    `Hire ${esc(hireSeller.id)}`,
    fields.map(schemaFieldHTML).join("") +
      `<label>How much are you willing to pay? (CR)<br /><input id="hire-budget" class="input" type="number" min="1" step="1" inputmode="numeric" value="${hireSeller.budget}" /></label>` +
      (Number.isInteger(price) ? `<p class="sub">≈ ${(price / 1000).toFixed(price % 1000 === 0 ? 0 : 3)} USDC settles on Base Sepolia.</p>` : ""),
    [
      { label: "Cancel", kind: "ghost", onClick: () => { $("modal").hidden = true; } },
      { label: "Open deal", onClick: submitHire },
    ],
  );
}

function collectBrief() {
  const metadata = {};
  const inputs = document.querySelectorAll("#modal-body [data-field]");
  for (const el of inputs) {
    const name = el.dataset.field;
    const t = el.dataset.type ?? "string";
    const required = el.dataset.required === "1";
    let value;
    if (t === "boolean") {
      value = el.checked;
    } else if (t === "integer" || t === "number") {
      const raw = el.value.trim();
      if (raw === "") {
        if (required) return { error: `Please fill in “${name}”.` };
        continue;
      }
      value = Number(raw);
      if (!Number.isFinite(value) || (t === "integer" && !Number.isInteger(value))) {
        return { error: `“${name}” must be ${t === "integer" ? "a whole number" : "a number"}.` };
      }
    } else {
      value = el.value.trim();
      if (value === "") {
        if (required) return { error: `Please fill in “${name}”.` };
        continue;
      }
    }
    metadata[name] = value;
  }
  if (Object.keys(metadata).length === 0) return { error: "Please describe what you need done." };
  return { metadata };
}

async function submitHire() {
  const budgetEl = $("hire-budget");
  const budget = budgetEl !== null ? Number(budgetEl.value) : NaN;
  if (!Number.isInteger(budget) || budget < 1) {
    toast("Budget must be a positive whole number of CR.");
    return;
  }
  const brief = collectBrief();
  if (brief.error) {
    toast(brief.error);
    return;
  }
  try {
    const buyer = await ensureBuyer();
    // No Idempotency-Key header: the protocol auto-generates one, so a
    // double-click retries safely. Every call carries the provisioned
    // buyer key: anonymous hires die at 401.
    const opened = await apiPost(
      "/api/deals",
      { buyer: buyer.id, seller: hireSeller.id, price: budget, metadata: brief.metadata },
      buyer.key,
      { idempotency: false },
    );
    $("modal").hidden = true;
    hireSeller = null;
    toast(`Deal ${opened.result.deal.id} opened at ${opened.result.deal.price} CR. Negotiation started.`);
    await loadMyDeals().catch(() => {});
    window.location.assign("/buyer");
  } catch (err) {
    toast(err.message ?? String(err));
  }
}

function setModal(stepText, stepNum, title, bodyHTML, actions) {
  $("hire-step").textContent = stepText;
  const track = document.querySelector(".hire-progress");
  if (track !== null && track.querySelector(".hire-steps") === null) {
    const labels = document.createElement("div");
    labels.className = "hire-steps";
    labels.innerHTML = `<span data-step="1">1. Brief</span><span data-step="2">2. Escrow</span>`;
    track.appendChild(labels);
  }
  const bar = document.querySelector(".hire-progress i");
  if (bar !== null) bar.style.width = stepNum === 1 ? "50%" : stepNum >= 2 ? "100%" : "0%";
  for (const label of document.querySelectorAll(".hire-steps [data-step]")) {
    label.classList.toggle("on", Number(label.dataset.step) <= stepNum);
  }
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

const apiPost = globalThis.apiPost ?? (async () => { throw new Error("apiPost unavailable"); });

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


// Trust is earned on-chain, not hashed from an id: per-agent settlement
// rates live in the admin console's verification rail, so cards show the
// seller's linked wallet and USDC terms instead of a fabricated score.

// Each row owns a stable id so flips target the row, never a re-render:
// no timers anywhere — a check lights only when its request resolves.
// Done rows print a green [OK] prefix like a system boot sequence.




let allAgents = [];

// Client-side + server-side filter state, initialized before any fetch so
// GET /api/agents never throws "filters is not defined".
const filters = { skill: "", service_type: "", query: "", category: "", sort: "featured" };

// Sync server-side filters from the UI dropdowns before each fetch.
function readServerFilters() {
  const serviceEl = document.getElementById("market-service-type");
  const skillEl = document.getElementById("market-skill");
  filters.service_type = serviceEl !== null ? serviceEl.value : "";
  filters.skill = skillEl !== null ? skillEl.value : "";
}

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

function schemaSummary(a) {
  const needs = schemaEntries(a?.input_schema).map((e) => e.name).filter((n) => typeof n === "string" && n !== "").slice(0, 3);
  return needs.length === 0 ? "" : `<div class="schema-needs sub" title="Fields the hire brief requires">Needs: ${needs.map(esc).join(", ")}</div>`;
}

function cardHTML(a) {
  const desc = typeof a.description === "string" && a.description.trim() !== "" ? a.description : null;
  return `<div class="card agent-card" role="button" tabindex="0" data-agent-id="${esc(a.id)}" data-role="${esc(a.role ?? "")}" data-price="${Number.isInteger(a.price) ? a.price : ""}" data-category="${esc(a.category ?? "")}" data-title="${esc(a.title ?? a.id)}" title="Hire ${esc(a.title ?? a.id)}">` +
    `<div class="badge-row"><span class="chip" data-category="${esc(a.category ?? "")}">${esc(categoryLabel(a.category))}</span>${serviceBadge(a)}</div>` +
    `<h2 class="agent-title" title="${esc(a.title ?? a.id)}">${esc(a.title ?? a.id)}</h2>` +
    (desc === null ? "" : `<p class="agent-desc" title="${esc(desc)}">${esc(desc)}</p>`) +
    `${skillsRow(a)}` +
    `${schemaSummary(a)}` +
    `<hr class="card-div" />` +
    `<div class="agent-foot">${priceTag(a.price)}<button class="btn hire-btn" data-id="${esc(a.id)}" data-price="${Number.isInteger(a.price) ? a.price : ""}">Hire →</button></div>` +
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
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const price = btn.dataset.price === "" ? null : Number(btn.dataset.price);
      hire(btn.dataset.id, price);
    });
  }
  for (const card of grid.querySelectorAll(".agent-card[data-agent-id]")) {
    const open = () => {
      const price = card.dataset.price === "" ? null : Number(card.dataset.price);
      hire(card.dataset.agentId, price);
    };
    card.addEventListener("click", (e) => {
      if (e.target.closest("button,a")) return;
      open();
    });
    card.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (e.target.closest("button,a")) return;
      e.preventDefault();
      open();
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
    readServerFilters();
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

// Buyer "Your deals" panel: post-hire view so a buyer can negotiate and pay
// without curl. Reads the provisioned buyer identity from localStorage, lists
// its deals, then enriches each via GET /api/deals/:id — the list rows carry
// no turn context, the detail adds waitingOn/allowedMoves/actions.
const DEAL_STATES = new Set(["NEGOTIATING", "AGREED", "ESCROW_LOCKED", "VERIFYING", "SETTLED", "REJECTED"]);

const DEAL_PILL = {
  NEGOTIATING: "negotiating",
  AGREED: "agreed",
  ESCROW_LOCKED: "escrow",
  EXECUTING: "executing",
  DELIVERED: "delivered",
  VERIFYING: "verifying",
  SETTLED: "settled",
  REJECTED: "rejected",
};

const apiGet = globalThis.apiGet ?? (async () => { throw new Error("apiGet unavailable"); });

function dealCardHTML(detail) {
  const deal = detail.deal;
  const waitingOn = detail.waitingOn;
  const buyerMoves = Array.isArray(detail.allowedMoves?.buyer) ? detail.allowedMoves.buyer : [];
  let turn = "";
  if (waitingOn === "buyer") {
    const btns = [];
    if (buyerMoves.includes("PAY")) btns.push(`<button class="btn" data-pay="${esc(deal.id)}">Pay ${deal.price} CR</button>`);
    if (buyerMoves.includes("OFFER")) btns.push(`<button class="btn" data-offer="${esc(deal.id)}">Make offer</button>`);
    if (buyerMoves.includes("ACCEPT")) btns.push(`<button class="btn" data-accept="${esc(deal.id)}" data-price="${deal.price}">Accept ${deal.price} CR</button>`);
    turn = `<p><span class="pill settled">Your turn</span></p>` +
      (btns.length > 0 ? `<div class="row">${btns.join("")}</div>` : `<p class="sub">Your move, via the deal endpoints.</p>`);
  } else {
    turn = `<p class="sub">Waiting on ${esc(waitingOn ?? "inspector")}.</p>`;
  }
  // Chain proofs ride the detail payload (GET /api/deals/:id now returns
  // pay_tx_hash / payout_tx_hash); list rows carry the dashboard's copies.
  const funding = txLink(detail.pay_tx_hash ?? deal.pay_tx_hash) ;
  const payout = txLink(detail.payout_tx_hash ?? deal.payout_tx_hash);
  const proofs = funding !== "" || payout !== ""
    ? `<div class="sub">Funding ${funding === "" ? "—" : funding} · Payout ${payout === "" ? "—" : payout}</div>`
    : "";
  return `<div class="card deal-card" data-deal-id="${esc(deal.id)}">` +
    `<div class="badge-row"><span class="pill ${DEAL_PILL[deal.state] ?? "active"}">${esc(deal.state)}</span></div>` +
    `<div class="agent-id">${esc(deal.id)} → ${esc(deal.seller)}</div>` +
    `${priceTag(deal.price)}` +
    `${proofs}` +
    `${turn}</div>`;
}

async function loadMyDeals() {
  const body = $("my-deals-body");
  if (body === null) return;
  // Public directory, private deals: auto-provision a guest buyer identity
  // (POST /api/agents {role:"buyer"}, key in localStorage) so the panel
  // never shows a red UNAUTHORIZED error and never crashes the page.
  let buyer = buyerIdentity();
  if (buyer === null) {
    try {
      buyer = await ensureBuyer();
    } catch {
      body.innerHTML = `<p class="sub">No deals yet. Hire a seller below.</p>`;
      return;
    }
  }
  let deals = [];
  try {
    const data = await apiGet("/api/deals?limit=100", buyer.key);
    deals = (data.result.deals ?? []).filter((d) => DEAL_STATES.has(d.state));
  } catch (err) {
    body.innerHTML = `<p class="sub">Could not load your deals: ${esc(err.message ?? String(err))}</p>`;
    return;
  }
  if (deals.length === 0) {
    body.innerHTML = `<p class="sub">No deals yet. Hire a seller below.</p>`;
    return;
  }
  const cards = [];
  for (const d of deals) {
    try {
      const detail = await apiGet(`/api/deals/${encodeURIComponent(d.id)}`, buyer.key);
      cards.push(dealCardHTML({ deal: detail.result.deal, waitingOn: detail.waitingOn, allowedMoves: detail.allowedMoves, pay_tx_hash: detail.result.pay_tx_hash ?? null, payout_tx_hash: detail.result.payout_tx_hash ?? null }));
    } catch {
      cards.push(`<div class="card deal-card"><div class="agent-id">${esc(d.id)}</div><p class="sub">Could not load turn status.</p></div>`);
    }
  }
  body.innerHTML = `<div class="agent-grid">${cards.join("")}</div>`;
}

async function payDeal(id) {
  const buyer = buyerIdentity();
  if (buyer === null) {
    toast("No buyer identity. Hire again to re-provision.");
    return;
  }
  // Real settlement: the buyer funds the escrow wallet on-chain first,
  // then hands the verified funding tx to the protocol. The server checks
  // the Transfer event (amount, sender, escrow) before locking escrow.
  const txHash = prompt("Paste the Base Sepolia USDC funding tx hash (0x…) for this deal:");
  if (txHash === null) return;
  if (!txHash.trim().startsWith("0x")) {
    toast("That does not look like a tx hash — expected a 0x-prefixed hash.");
    return;
  }
  try {
    await apiPost(`/api/deals/${encodeURIComponent(id)}/pay`, { tx_hash: txHash.trim() }, buyer.key);
    toast(`Deal ${id} paid. Escrow locked.`);
  } catch (err) {
    toast(err.message ?? String(err));
  }
  await loadMyDeals();
}

async function offerDeal(id) {
  const buyer = buyerIdentity();
  if (buyer === null) {
    toast("No buyer identity. Hire again to re-provision.");
    return;
  }
  const raw = prompt("Offer price (CR, whole number):");
  if (raw === null) return;
  const price = Number(raw.trim());
  if (!Number.isInteger(price) || price < 1) {
    toast("Price must be a positive whole number of CR.");
    return;
  }
  try {
    await apiPost(`/api/deals/${encodeURIComponent(id)}/moves`, { key: crypto.randomUUID(), kind: "OFFER", price }, buyer.key);
    toast(`Offer of ${price} CR sent on deal ${id}.`);
  } catch (err) {
    toast(err.message ?? String(err));
  }
  await loadMyDeals();
}

async function acceptDeal(id, price) {
  const buyer = buyerIdentity();
  if (buyer === null) {
    toast("No buyer identity. Hire again to re-provision.");
    return;
  }
  try {
    await apiPost(`/api/deals/${encodeURIComponent(id)}/moves`, { key: crypto.randomUUID(), kind: "ACCEPT", price }, buyer.key);
    toast(`Deal ${id} accepted at ${price} CR.`);
  } catch (err) {
    toast(err.message ?? String(err));
  }
  await loadMyDeals();
}

const dealsBody = $("my-deals-body");
if (dealsBody !== null) dealsBody.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-pay],[data-offer],[data-accept]");
  if (btn === null) return;
  if (btn.hasAttribute("data-pay")) payDeal(btn.dataset.pay);
  else if (btn.hasAttribute("data-offer")) offerDeal(btn.dataset.offer);
  else if (btn.hasAttribute("data-accept")) acceptDeal(btn.dataset.accept, Number(btn.dataset.price));
});

const dealsToggle = $("my-deals-toggle");
if (dealsToggle !== null) dealsToggle.addEventListener("click", () => {
  const body = $("my-deals-body");
  if (body === null) return;
  const hidden = body.hidden;
  body.hidden = !hidden;
  dealsToggle.textContent = hidden ? "Show" : "Hide";
  dealsToggle.setAttribute("aria-expanded", String(hidden));
});

const bannerConnect = $("banner-connect");
if (bannerConnect !== null) bannerConnect.addEventListener("click", () => {
  const walletBtn = $("connect-wallet");
  if (walletBtn !== null) walletBtn.click();
});

load();
loadMyDeals();

// Unified Identity Layer (SIWE): wallet sign-in that resolves to the
// existing x-agent-key. Overwrites the auto-provisioned guest identity so
// every later deal call authenticates as the wallet-linked agent.
const truncateAddress = globalThis.truncateAddress ?? ((address) => String(address ?? ""));

function walletConnected() {
  try {
    const stored = JSON.parse(localStorage.getItem(BUYER_KEY) ?? "null");
    if (typeof stored?.wallet === "string" && stored.wallet.startsWith("0x")) return stored.wallet;
  } catch {
    // Corrupt entry: treated as disconnected.
  }
  return null;
}

// Balance line inside the dropdown: live buyer balance from GET /api/me.
// Any failure (offline, expired key) leaves the placeholder — never an error.
async function fillWalletDropdown(walletAddress) {
  const addrEl = document.getElementById("wallet-addr");
  const balEl = document.getElementById("wallet-balance");
  if (addrEl !== null) addrEl.textContent = walletAddress;
  if (balEl === null) return;
  const stored = buyerIdentity();
  if (stored === null) {
    balEl.textContent = "CR Balance: —";
    return;
  }
  try {
    const me = await apiGet("/api/me", stored.key);
    const bal = me.result?.balance;
    balEl.textContent = `CR Balance: ${Number.isInteger(bal) ? `${bal} CR` : "—"}`;
  } catch {
    balEl.textContent = "CR Balance: —";
  }
}

function setWalletConnected(btn, walletAddress) {
  if (btn !== null) {
    btn.textContent = truncateAddress(walletAddress);
    btn.title = `Signed in as ${walletAddress} (Base Sepolia)`;
    btn.className = "btn";
  }
  const tag = document.getElementById("chain-tag");
  if (tag !== null) tag.hidden = false;
  fillWalletDropdown(walletAddress).catch(() => {});
}

function setWalletDisconnected(btn) {
  if (btn !== null) {
    btn.textContent = "Connect Wallet";
    btn.title = "Sign in with your wallet (SIWE)";
    btn.className = "btn btn-outline";
  }
  const tag = document.getElementById("chain-tag");
  if (tag !== null) tag.hidden = true;
  const dd = document.getElementById("wallet-dropdown");
  if (dd !== null) dd.hidden = true;
}

function toggleWalletDropdown() {
  const dd = document.getElementById("wallet-dropdown");
  if (dd !== null) dd.hidden = !dd.hidden;
}

function paintWalletButton() {
  const btn = $("connect-wallet");
  if (btn === null) return;
  const wallet = walletConnected();
  if (wallet !== null) setWalletConnected(btn, wallet);
  else setWalletDisconnected(btn);
}

async function connectWallet() {
  const btn = $("connect-wallet");
  if (typeof window.ethereum === "undefined" || window.ethereum === null) {
    toast("No wallet found. Install MetaMask to sign in.");
    return;
  }
  try {
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    const walletAddress = Array.isArray(accounts) ? accounts[0] : null;
    if (typeof walletAddress !== "string" || walletAddress === "") {
      toast("No account selected.");
      return;
    }
    const nonceRes = await fetch(`/api/auth/nonce?wallet_address=${encodeURIComponent(walletAddress)}`);
    const nonceData = await nonceRes.json();
    if (!nonceRes.ok || nonceData.ok !== true) {
      throw new Error(`${nonceData.error?.code ?? nonceRes.status}: ${nonceData.error?.message ?? "nonce failed"}`);
    }
    const message = nonceData.result.message;
    const signature = await window.ethereum.request({ method: "personal_sign", params: [message, walletAddress] });
    const verifyRes = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, signature, wallet_address: walletAddress }),
    });
    const verifyData = await verifyRes.json();
    if (!verifyRes.ok || verifyData.ok !== true) {
      throw new Error(`${verifyData.error?.code ?? verifyRes.status}: ${verifyData.error?.message ?? "verify failed"}`);
    }
    // Guest-deal guard: a web-buyer-* identity holds deals that the wallet
    // identity cannot see. Ask before overwriting; declining keeps the guest.
    const previous = buyerIdentity();
    if (previous !== null && typeof previous.id === "string" && previous.id.startsWith("web-buyer-") && typeof confirm === "function") {
      const link = confirm("You have active deals as a guest. Link your wallet?\n\nYour guest deals stay on the protocol under the guest id; this view will refresh to your wallet's deals.");
      if (!link) {
        toast("Staying on your guest identity.");
        return;
      }
      toast("Wallet linked. Guest deals remain on the protocol under the guest id.");
    }
    try {
      localStorage.setItem(BUYER_KEY, JSON.stringify({ id: verifyData.result.agent_id, key: verifyData.result.api_key, wallet: walletAddress }));
    } catch {
      // Blocked storage: session still works until reload.
    }
    try {
      sessionStorage.removeItem("just_disconnected");
    } catch {
      // Blocked storage: the fresh identity already proves sign-in.
    }
    setWalletConnected(btn, walletAddress);
    toast(`Signed in as ${truncateAddress(walletAddress)}.`);
    await loadMyDeals().catch(() => {});
  } catch (err) {
    toast(err?.message ?? String(err));
  }
}

{
  const btn = document.getElementById("connect-wallet");
  if (btn !== null) btn.addEventListener("click", () => {
    // Connected: the button toggles the wallet menu. Disconnected: it
    // starts SIWE sign-in. No fetch or storage change happens on toggle.
    if (walletConnected() !== null) toggleWalletDropdown();
    else connectWallet();
  });
  const copy = document.getElementById("wallet-copy");
  if (copy !== null) copy.addEventListener("click", async () => {
    const wallet = walletConnected();
    if (wallet === null) return;
    try {
      await navigator.clipboard.writeText(wallet);
      toast("Address copied.");
    } catch {
      toast("Copy failed — select the address manually.");
    }
  });
  const discon = document.getElementById("wallet-disconnect");
  if (discon !== null) discon.addEventListener("click", () => {
    try {
      localStorage.removeItem(BUYER_KEY);
    } catch {
      // Blocked storage: the reload below still drops the session.
    }
    try {
      // The buyer page honors this: no silent ghost mint after disconnect.
      sessionStorage.setItem("just_disconnected", "true");
    } catch {
      // Blocked storage: the reload below still drops the session.
    }
    setWalletDisconnected(document.getElementById("connect-wallet"));
    toast("Wallet disconnected.");
    location.reload();
  });
  if (typeof document.addEventListener === "function") {
    document.addEventListener("click", (e) => {
      const dd = document.getElementById("wallet-dropdown");
      const wrap = e.target?.closest?.(".wallet-wrap") ?? null;
      if (dd !== null && dd.hidden === false && wrap === null) dd.hidden = true;
    });
  }
  paintWalletButton();
}
