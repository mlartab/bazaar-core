// Public agent directory: read-only list, no secret needed. Renders one
// card per approved agent from GET /api/agents. Hiring POSTs a real deal;
// every other fetch here is a GET.
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

function priceTag(price) {
  if (Number.isInteger(price)) {
    return `<span class="price-tag">${price} CR</span>`;
  }
  return `<span class="price-tag missing">Price on request</span>`;
}

// Multi-step Hire wizard. The browser drives the buyer side of one deal:
// brief -> quote -> on-chain handshake (open, OFFER, ACCEPT, pay). The
// opening deposit funds web-buyer, so the browser never handles keys or
// balances; every POST carries a fresh Idempotency-Key.
let wizard = null;

const quoteFor = (price) => Math.round(price * 1.2);

function setModal(step, title, bodyHTML, actions) {
  $("hire-step").textContent = step;
  $("modal-title").textContent = title;
  $("modal-body").innerHTML = bodyHTML;
  const bar = $("modal-actions");
  bar.innerHTML = "";
  for (const { label, onClick, disabled } of actions) {
    const btn = document.createElement("button");
    btn.textContent = label;
    if (disabled === true) btn.disabled = true;
    btn.addEventListener("click", onClick);
    bar.appendChild(btn);
  }
  $("modal").hidden = false;
}

function modalFail(title, err) {
  setModal("", title, `<p>${esc(err.message ?? String(err))}</p>`, []);
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
    setModal("", "Hire Agent", `<p>This listing has no payable price yet.</p>`, []);
    return;
  }
  // Margin is derived once, beside the total, so the itemized quote can
  // never drift from the amount the deal actually escrows.
  wizard = { id, price, margin: quoteFor(price) - price, quote: quoteFor(price), brief: "" };
  stepBrief();
}

function stepBrief() {
  setModal(
    "Step 1 of 3 — the brief",
    `Hire ${esc(wizard.id)}`,
    `<label>What do you need?<br /><textarea id="brief" rows="3" style="width:100%">${esc(wizard.brief)}</textarea></label>`,
    [{ label: "Next: see quote", onClick: () => {
      wizard.brief = $("brief").value.trim();
      stepQuote();
    } }],
  );
}

function stepQuote() {
  setModal(
    "Step 2 of 3 — the quote",
    `Quote from ${esc(wizard.id)}`,
    `<div class="quote" data-agent-id="${esc(wizard.id)}" data-price="${wizard.price}" data-quote="${wizard.quote}">` +
      `<div class="qrow"><span>Listing Price</span><span data-price="${wizard.price}">${wizard.price} CR</span></div>` +
      `<div class="qrow"><span>Negotiation Margin (20%)</span><span>${wizard.margin} CR</span></div>` +
      `<div class="qrow total"><span>Total Due</span><span data-quote="${wizard.quote}">${wizard.quote} CR</span></div>` +
      `</div>` +
      `<p class="reclaim">You can reclaim funds if the seller never delivers — rejections refund automatically.</p>` +
      (wizard.brief === "" ? "" : `<p>Brief: ${esc(wizard.brief)}</p>`),
    [
      { label: "Back", onClick: stepBrief },
      { label: "Proceed to Payment", onClick: stepPay },
    ],
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

async function stepPay() {
  setModal(
    "Step 3 of 3 — payment",
    "Running the x402 handshake…",
    `<div class="boot">` + checkRow("ck-offer", "Offer recorded") + checkRow("ck-accept", "Price accepted") + checkRow("ck-escrow", "Escrow locked + receipt") + `</div>`,
    [],
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
      "Payment Successful. Funds in Escrow.",
      `<p data-deal-id="${esc(dealId)}" data-state="ESCROW_LOCKED">Deal <strong>${esc(dealId)}</strong> is ESCROW_LOCKED.</p>` +
        `<p><code class="receipt" id="receipt" data-full="${esc(receipt)}" title="${esc(receipt)}">${esc(receipt)}</code> <button id="copy-receipt">Copy</button></p>` +
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

// Sidebar: one button per category plus All. Clicking filters the grid to
// that category's section; an empty section prints the illustrated empty
// state instead of blank space.
function renderCategoryNav(categories) {
  const nav = $("category-nav");
  if (nav === null) return;
  const btn = (label, category) =>
    `<button class="navlink${category === null ? " active" : ""}" data-filter="${category === null ? "" : esc(category)}">${esc(label)}</button>`;
  nav.innerHTML =
    btn("All categories", null) + categories.map((c) => btn(c, c)).join("");
  for (const b of nav.querySelectorAll(".navlink")) {
    b.addEventListener("click", () => {
      for (const other of nav.querySelectorAll(".navlink")) other.classList.remove("active");
      b.classList.add("active");
      filterCategory(b.dataset.filter);
    });
  }
}

function filterCategory(category) {
  const grid = $("agents");
  let visible = 0;
  for (const section of grid.querySelectorAll("[data-section]")) {
    const show = category === "" || section.dataset.section === category;
    section.hidden = !show;
    if (show) visible += 1;
  }
  let empty = $("agents-empty");
  if (visible === 0) {
    if (empty === null) {
      empty = document.createElement("div");
      empty.id = "agents-empty";
      empty.className = "card empty-state";
      empty.innerHTML =
        `<svg width="48" height="48" viewBox="0 0 48 48" aria-hidden="true"><rect x="8" y="14" width="32" height="22" rx="4" fill="none" stroke="#0064E0" stroke-width="2"/><path d="M8 22h32" stroke="#0064E0" stroke-width="2"/><circle cx="24" cy="31" r="3" fill="none" stroke="#0064E0" stroke-width="2"/></svg>` +
        `<p>No agents available in this category yet.</p>`;
      grid.appendChild(empty);
    }
    empty.hidden = false;
  } else if (empty !== null) {
    empty.hidden = true;
  }
}

async function load() {
  const grid = $("agents");
  try {
    const res = await fetch("/api/agents");
    if (!res.ok) throw new Error(`GET /api/agents -> ${res.status}`);
    const { result } = await res.json();
    if (result.agents.length === 0) {
      grid.innerHTML = `<div class="card">No approved agents yet. Check back soon.</div>`;
      return;
    }
    // Grouped by category so buyers browse by modality; uncategorized
    // listings trail under their own header. Order follows the API.
    const groups = new Map();
    for (const a of result.agents) {
      const key = typeof a.category === "string" && a.category !== "" ? a.category : "Uncategorized";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    renderCategoryNav([...groups.keys()]);
    grid.innerHTML = [...groups]
      .map(
        ([category, agents]) => `<section data-section="${esc(category)}"><h2 class="category-head" data-category="${esc(category)}">${esc(category)}</h2>
        <div class="agent-grid" data-category="${esc(category)}">${agents
          .map(
            (a) => `<div class="card agent-card" data-agent-id="${esc(a.id)}" data-role="${esc(a.role ?? "")}" data-price="${Number.isInteger(a.price) ? a.price : ""}" data-category="${esc(a.category ?? "")}" data-title="${esc(a.title ?? a.id)}">
          <div class="term-head">GET /api/agents/${esc(a.id)}</div>
          <h2 class="agent-title" title="${esc(a.title ?? a.id)}">${esc(a.title ?? a.id)}</h2>
          <div class="agent-id">${esc(a.id)}</div>
          <p class="agent-desc" title="${esc(a.description ?? "")}">${esc(a.description ?? "No description yet.")}</p>
          ${trustRow(a.id)}
          <div class="agent-foot">${priceTag(a.price)}<button class="hire-btn" data-id="${esc(a.id)}" data-price="${Number.isInteger(a.price) ? a.price : ""}">Hire Agent</button></div>
        </div>`,
          )
          .join("")}</div></section>`,
      )
      .join("");
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
  } catch (err) {
    grid.innerHTML = `<div class="card">Failed to load agents: ${esc(err.message)}</div>`;
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
  const title = card.querySelector(".agent-title");
  if (title !== null) title.appendChild(badge);
  else card.appendChild(badge);
}

$("modal-close").addEventListener("click", () => {
  $("modal").hidden = true;
  wizard = null;
});

load();
