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

function priceTag(price) {
  if (Number.isInteger(price)) {
    return `<span class="price-tag">${price} CR</span>`;
  }
  return `<span class="price-tag missing">Price on request</span>`;
}

// Two-step Hire wizard. Review collects the brief beside the price;
// Confirm runs the buyer side of one deal: open, OFFER, ACCEPT, pay. The
// opening deposit funds web-buyer, so the browser never handles keys or
// balances; every POST carries a fresh Idempotency-Key.
let wizard = null;

const quoteFor = (price) => Math.round(price * 1.2);

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

async function apiPost(path, body, agentKey) {
  const headers = { "content-type": "application/json", "idempotency-key": crypto.randomUUID() };
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

function hire(id, price) {
  if (!Number.isInteger(price) || quoteFor(price) < 1) {
    setModal("", 0, "Hire Agent", `<p>This listing has no payable price yet.</p>`, []);
    return;
  }
  // Margin is derived once, beside the total, so the itemized quote can
  // never drift from the amount the deal actually escrows.
  wizard = { id, price, margin: quoteFor(price) - price, quote: quoteFor(price), brief: "" };
  stepReview();
}

function stepReview() {
  setModal(
    "Step 1 of 2 — Review",
    1,
    `Hire ${esc(wizard.id)}`,
    `<label>What do you need?<br /><textarea id="brief" class="input" rows="3">${esc(wizard.brief)}</textarea></label>` +
      `<div class="quote" data-agent-id="${esc(wizard.id)}" data-price="${wizard.price}" data-quote="${wizard.quote}">` +
      `<div class="qrow"><span>Listing Price</span><span data-price="${wizard.price}">${wizard.price} CR</span></div>` +
      `<div class="qrow"><span>Negotiation Margin (20%)</span><span>${wizard.margin} CR</span></div>` +
      `<div class="qrow total"><span>Total Due</span><span data-quote="${wizard.quote}">${wizard.quote} CR</span></div>` +
      `</div>` +
      `<p class="reclaim">Your ${wizard.quote} CR locks in escrow and releases only on verified delivery — rejections refund automatically.</p>` +
      (wizard.brief === "" ? "" : `<p>Brief: ${esc(wizard.brief)}</p>`),
    [{ label: "Continue to payment", onClick: () => {
      const el = $("brief");
      wizard.brief = el !== null ? el.value.trim() : "";
      stepConfirm();
    } }],
  );
}

// Deterministic display-only reputation: hash the agent id into 1-5 bars.
// Labeled beta in the UI; it never implies server-side scoring.
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
function checkRow(id, label) {
  return `<div class="check" id="${id}" data-state="pending" data-step="${esc(label)}"><span class="box"></span><span class="check-label">${label}</span><span class="check-err"></span></div>`;
}

function setCheck(id, state, err) {
  const row = $(id);
  if (row === null) return;
  row.dataset.state = state;
  const label = row.querySelector(".check-label");
  if (state === "done" && label !== null && label.querySelector(".ok-tag") === null) {
    label.innerHTML = `<span class="ok-tag">[OK]</span> ${esc(label.textContent)}`;
  }
  if (err !== undefined) row.querySelector(".check-err").textContent = err;
}

// Swept quotes surface as lock errors on pay: translate the machine code
// into the one sentence the buyer needs.
function friendlyPayError(err) {
  const message = String(err?.message ?? err);
  if (message.includes("ALREADY_LOCKED") || message.includes("NEEDS_ACCEPTANCE")) {
    return "This quote expired before capture. Please start a new hire.";
  }
  return message;
}

async function copyReceipt() {
  const btn = $("copy-receipt");
  const code = $("receipt");
  const text = code.dataset.full ?? code.textContent;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Non-secure origins reject the clipboard API: select the receipt so
    // the buyer can copy it manually instead of failing silently.
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    btn.textContent = "Select + Ctrl+C";
    return;
  }
  btn.textContent = "Copied";
}

async function stepConfirm() {
  setModal(
    "Step 2 of 2 — Confirm",
    2,
    "Running the x402 handshake…",
    `<div class="boot">` + checkRow("ck-offer", "Offer recorded") + checkRow("ck-accept", "Price accepted") + checkRow("ck-escrow", "Escrow locked + receipt") + `</div>`,
    [{ label: "Back", kind: "ghost", onClick: stepReview }],
  );
  try {
    const buyer = await ensureBuyer();
    const dealId = `deal-${Date.now()}`;
    // Open at the quote so the deposit covers it; offer at the listing
    // price and accept at the quote — matching prices trip the referee's
    // duplicate-offer rule, and a higher accept would exceed the budget.
    // Every call carries the provisioned buyer key: anonymous hires die at 401.
    setCheck("ck-offer", "active");
    await apiPost("/api/deals", { id: dealId, buyer: buyer.id, seller: wizard.id, price: wizard.quote }, buyer.key);
    await apiPost(`/api/deals/${encodeURIComponent(dealId)}/moves`, { key: "offer", kind: "OFFER", price: wizard.price }, buyer.key);
    setCheck("ck-offer", "done");
    setCheck("ck-accept", "active");
    await apiPost(`/api/deals/${encodeURIComponent(dealId)}/moves`, { key: "accept", kind: "ACCEPT", price: wizard.quote }, buyer.key);
    setCheck("ck-accept", "done");
    setCheck("ck-escrow", "active");
    const paid = await apiPost(`/api/deals/${encodeURIComponent(dealId)}/pay`, {}, buyer.key);
    setCheck("ck-escrow", "done");
    const receipt = paid.result.receipt;
    setModal(
      "Done",
      2,
      "Payment Successful. Funds in Escrow.",
      `<p data-deal-id="${esc(dealId)}" data-state="ESCROW_LOCKED">Deal <strong>${esc(dealId)}</strong> is ESCROW_LOCKED.</p>` +
        `<p><code class="receipt" id="receipt" data-full="${esc(receipt)}" title="${esc(receipt)}">${esc(receipt)}</code> <button class="btn" id="copy-receipt">Copy</button></p>` +
        `<p class="sub">Track it in the Admin Console deals table.</p>`,
      [],
    );
    $("copy-receipt").addEventListener("click", copyReceipt);
  } catch (err) {
    // Freeze on the failed row; a row is only ever marked by its own
    // request's outcome, so the buyer sees exactly where capture stopped.
    const message = friendlyPayError(err);
    const active = document.querySelector(".check[data-state='active']");
    if (active !== null) {
      setCheck(active.id, "failed", message);
      $("modal-title").textContent = "Payment failed";
    } else {
      modalFail("Payment failed", err);
    }
  }
}

// Client-side filter state: one flat grid, re-rendered on every change.
const filters = { query: "", category: "", sort: "featured" };
let allAgents = [];

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
    `<div class="badge-row"><span class="chip" data-category="${esc(a.category ?? "")}">${esc(categoryLabel(a.category))}</span></div>` +
    `<h2 class="agent-title" title="${esc(a.title ?? a.id)}">${esc(a.title ?? a.id)}</h2>` +
    `<div class="agent-id">${esc(a.id)}</div>` +
    (desc === null ? "" : `<p class="agent-desc" title="${esc(desc)}">${esc(desc)}</p>`) +
    `${trustRow(a.id)}` +
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
  if (filters.query.trim() !== "") chips.push({ key: "query", label: `“${filters.query.trim()}”` });
  if (filters.sort !== "featured") chips.push({ key: "sort", label: $("market-sort").selectedOptions[0].textContent });
  holder.innerHTML = chips.map((c) => `<button class="chip active" data-chip="${c.key}">${esc(c.label)} ✕</button>`).join("") +
    (chips.length > 0 ? `<button class="chip" data-chip="__all">Clear all</button>` : "");
  for (const btn of holder.querySelectorAll("[data-chip]")) {
    btn.addEventListener("click", () => {
      const key = btn.dataset.chip;
      if (key === "category" || key === "__all") filters.category = "";
      if (key === "query" || key === "__all") {
        filters.query = "";
        $("market-search").value = "";
      }
      if (key === "sort" || key === "__all") {
        filters.sort = "featured";
        $("market-sort").value = "featured";
      }
      syncCategoryControls();
      render();
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
      $("market-search").value = "";
      $("market-sort").value = "featured";
      syncCategoryControls();
      render();
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
    const res = await fetch("/api/agents");
    if (!res.ok) throw new Error(`GET /api/agents -> ${res.status}`);
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

$("modal-close").addEventListener("click", () => {
  $("modal").hidden = true;
  wizard = null;
});

load();
