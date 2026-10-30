// Seller dashboard: the supply side of the protocol. Credentials live in
// sessionStorage (tab-scoped: closing the tab forgets the key), and every
// deal call reuses the existing protocol endpoints with the seller's key —
// no seller-specific API exists by design.

const $ = (id) => document.getElementById(id);
const SELLER_KEY = "bazaar-seller-identity";
let selected = null;

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);

const identity = () => {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(SELLER_KEY) ?? "null");
    if (typeof parsed?.id === "string" && typeof parsed?.key === "string") return parsed;
  } catch {
    // Corrupt entry: fall through to the gate.
  }
  return null;
};

function logout() {
  try {
    sessionStorage.removeItem(SELLER_KEY);
  } catch {
    // Storage already gone: the gate is the correct place anyway.
  }
  selected = null;
  $("board").hidden = true;
  $("logout").hidden = true;
  $("gate").hidden = false;
}

async function api(path, { method = "GET", body, key } = {}) {
  const me = identity();
  const headers = {};
  if (key !== undefined) headers["x-agent-key"] = key;
  else if (me !== null) headers["x-agent-key"] = me.key;
  const init = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["idempotency-key"] = crypto.randomUUID();
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (res.status === 401) {
    logout();
    throw new Error("Session expired. Please log in again.");
  }
  const data = await res.json();
  if (!res.ok || data.ok !== true) {
    throw new Error(`${data.error?.code ?? res.status}: ${data.error?.message ?? "request failed"}`);
  }
  return data;
}

// Countdown mirrors the admin console: only live negotiations count down,
// everything else shows a dash.
function expiresIn(d) {
  const stamp = d.state === "ESCROW_LOCKED" ? d.delivery_expires_at : d.expires_at;
  if ((d.state !== "NEGOTIATING" && d.state !== "AGREED" && d.state !== "ESCROW_LOCKED") || typeof stamp !== "number") return "—";
  const left = stamp - Date.now();
  if (left <= 0) return "expiring…";
  const s = Math.ceil(left / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

async function renderProfile(me) {
  // Public face, straight from the Trust Passport: exactly what a buyer
  // sees. Silent on failure — deals below must load even if the replica
  // is down (the endpoint falls back to SQLite itself).
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(me.id)}/profile`);
    if (!res.ok) return;
    const { result } = await res.json();
    if (result === undefined) return;
    $("profile-title").textContent = result.title ?? me.id;
    $("profile-id").textContent = me.id;
    $("profile-desc").textContent = result.description ?? "No description yet.";
    const price = Number.isInteger(result.price) ? `${result.price} CR` : "Unpriced";
    const category = typeof result.category === "string" && result.category !== "" ? result.category : "Uncategorized";
    $("profile-meta").innerHTML =
      `<span class="pill" data-price="${result.price ?? ""}">${esc(price)}</span>` +
      `<span class="pill active" data-category="${esc(category)}">${esc(category)}</span>`;
    $("profile-head").dataset.agentId = me.id;
  } catch {
    // Offline replica: header keeps its placeholders, deals still load.
  }
}

const CATEGORY_LABELS = {
  image_gen: "Image Gen",
  video_gen: "Video Gen",
  text_gen: "Text Gen",
  data: "Data",
  speech: "Speech",
};

const categoryLabel = (c) => CATEGORY_LABELS[c] ?? "Uncategorized";

// Strategy card: the seller's own listing strategy, straight from the
// public directory row. Pending (unapproved) sellers see a queue note
// instead — the operator decides what goes live, never this pane.
function renderStrategy(me, agents) {
  const card = $("strategy-card");
  const row = agents.find((a) => a.id === me.id) ?? null;
  if (row === null) {
    card.hidden = false;
    $("strategy-badge").innerHTML = `<span class="pill pending">Pending review</span>`;
    $("strategy-line").textContent = "Your listing is in the operator review queue. Strategy appears here once approved.";
    $("strategy-skills").innerHTML = "";
    return;
  }
  const svc = row.service_type === "endpoint" || row.service_type === "compute" ? row.service_type : "negotiation";
  const label = svc === "negotiation" ? "Negotiation" : svc === "endpoint" ? "Endpoint" : "Compute";
  const line = svc === "negotiation"
    ? (Number.isInteger(row.min_price) ? `Open to offers from ${row.min_price} CR.` : "Open to offers — no floor set.")
    : (Number.isInteger(row.price) ? `Fixed price: ${row.price} CR per call.` : "Fixed price: unpriced.");
  card.hidden = false;
  $("strategy-badge").innerHTML = `<span class="pill svc-${esc(svc)}">${esc(label)}</span>`;
  $("strategy-line").textContent = line;
  const skills = Array.isArray(row.skills) ? row.skills.filter((s) => typeof s === "string").slice(0, 10) : [];
  $("strategy-skills").innerHTML = skills.map((s) => `<span class="skill-tag">${esc(s)}</span>`).join("");
}

// Storefront: every approved listing under this seller's namespace — the
// seller's own record plus any `${id}:suffix` sub-listings created from the
// Add New Listing modal — grouped by category like the marketplace.
async function renderStorefront(me) {
  const box = $("listings");
  try {
    const res = await fetch("/api/agents");
    if (!res.ok) throw new Error(`GET /api/agents -> ${res.status}`);
    const { result } = await res.json();
    renderStrategy(me, result.agents);
    const mine = result.agents.filter((a) => a.id === me.id || a.id.startsWith(`${me.id}:`));
    if (mine.length === 0) {
      box.innerHTML = `<p class="sub">No live listings yet. New listings appear here after operator approval.</p>`;
      return;
    }
    const groups = new Map();
    for (const a of mine) {
      const key = typeof a.category === "string" && a.category !== "" ? a.category : "Uncategorized";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    box.innerHTML = [...groups]
      .map(
        ([category, agents]) =>
          `<h3 class="category-head" data-category="${esc(category)}">${esc(categoryLabel(category))}</h3>` +
          `<div class="agent-grid" data-category="${esc(category)}">` +
          agents
            .map(
              (a) =>
                `<div class="card agent-card" data-agent-id="${esc(a.id)}" data-category="${esc(a.category ?? "")}" data-price="${Number.isInteger(a.price) ? a.price : ""}" data-title="${esc(a.title ?? a.id)}">` +
                `<h2 class="agent-title" title="${esc(a.title ?? a.id)}">${esc(a.title ?? a.id)}</h2>` +
                `<div class="agent-id">${esc(a.id)}</div>` +
                `<p class="agent-desc" title="${esc(a.description ?? "")}">${esc(a.description ?? "No description yet.")}</p>` +
                `<div class="agent-foot">${priceTag(a.price)}</div>` +
                `</div>`,
            )
            .join("") +
          `</div>`,
      )
      .join("");
  } catch {
    box.innerHTML = `<p class="sub">Could not load listings.</p>`;
  }
  // Verified Owner: the profile carries the linked owner email when the
  // seller completed self-serve identity linking.
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(me.id)}/profile`);
    if (!res.ok) return;
    const { result } = await res.json();
    if (result !== undefined && (result.email !== null || result.owner_email !== null)) {
      const badge = $("verified-owner");
      badge.hidden = false;
      badge.innerHTML =
        `<span class="verified-badge" data-verified-owner="true" title="Linked owner email confirmed">` +
        `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="#0064E0"/><path d="M11.2 6.2 7.4 10l-2.6-2.6 1.1-1.1 1.5 1.5 2.7-2.7z" fill="#fff"/></svg> Verified Owner</span>`;
    }
  } catch {
    // Offline replica: no badge, listings above still stand.
  }
}

function priceTag(price) {
  if (Number.isInteger(price)) return `<span class="price-tag">${price} CR</span>`;
  return `<span class="price-tag missing">Price on request</span>`;
}

async function load() {
  const me = identity();
  if (me === null) return;
  $("seller-name").textContent = `— ${me.id}`;
  renderProfile(me).catch(() => {});
  renderStorefront(me).catch(() => {});
  const { result } = await api("/api/deals");
  const mine = result.deals.filter((d) => d.seller === me.id);
  if (result.deals.length > 0 && mine.length === 0) {
    // The key is valid (otherwise we would have 401'd), but the typed ID
    // names nobody in these deals: the data below stays empty rather than
    // leaking another agent's rows, which the server never sends us anyway.
    $("detail").textContent = `Logged in with a valid key, but no deal names seller "${me.id}" — check the Agent ID.`;
  }
  const pill = (state) => {
    const cls = { NEGOTIATING: "negotiating", AGREED: "agreed", ESCROW_LOCKED: "escrow", EXECUTING: "executing", DELIVERED: "delivered", VERIFYING: "verifying", SETTLED: "settled", REJECTED: "rejected" }[state] ?? "active";
    return `<span class="pill ${cls}" data-state="${esc(state)}">${esc(state)}</span>`;
  };
  $("deals").innerHTML = mine
    .map(
      (d) =>
        `<tr data-id="${esc(d.id)}" data-deal-id="${esc(d.id)}" data-state="${esc(d.state)}" data-price="${d.price ?? ""}" data-buyer="${esc(d.buyer ?? "")}"><td data-deal-id="${esc(d.id)}">${esc(d.id)}</td><td>${esc(d.buyer ?? "")}</td><td>${pill(d.state)}</td><td data-price="${d.price ?? ""}">${d.price ?? ""}</td><td>${expiresIn(d)}</td></tr>`,
    )
    .join("");
  if (mine.length === 0) {
    $("deals").innerHTML = `<tr><td colspan="5">No deals yet. Approved listings appear in the marketplace.</td></tr>`;
  }
  for (const row of document.querySelectorAll("#deals tr[data-id]")) {
    row.addEventListener("click", () => showDeal(row.dataset.id));
  }
  if (selected !== null) showDeal(selected).catch(() => {});
}

function lastOffer(moves) {
  const offers = moves.filter((m) => m.kind === "OFFER" || m.kind === "ACCEPT");
  return offers.length === 0 ? null : offers[offers.length - 1].price;
}

async function showDeal(id) {
  selected = id;
  try {
    const { result } = await api(`/api/deals/${encodeURIComponent(id)}`);
    $("detail").textContent = JSON.stringify(result, null, 2);
    renderActions(result.deal, result.moves);
  } catch (err) {
    $("detail").textContent = `Failed to load ${id}: ${err.message}`;
    $("deal-actions").innerHTML = "";
  }
}

function renderActions(deal, moves) {
  const bar = $("deal-actions");
  bar.innerHTML = "";
  const me = identity();
  if (me === null || deal.seller !== me.id) return;
  if (deal.state === "NEGOTIATING") {
    const offer = lastOffer(moves ?? []);
    const label = document.createElement("label");
    label.innerHTML = `Accept at (CR)<br />`;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.value = offer ?? deal.price ?? "";
    input.id = "accept-price";
    label.appendChild(input);
    const btn = document.createElement("button");
    btn.textContent = "Accept";
    btn.addEventListener("click", async () => {
      // The seller names the acceptance price: matching the last offer
      // trips the referee's duplicate rule, so the input invites a real
      // counter. The server is the final judge either way.
      const price = Number($("accept-price").value);
      try {
        await api(`/api/deals/${encodeURIComponent(deal.id)}/moves`, {
          method: "POST",
          body: { key: `accept-${Date.now()}`, kind: "ACCEPT", price },
        });
        await load();
      } catch (err) {
        $("detail").textContent = `Accept failed: ${err.message}`;
      }
    });
    bar.append(label, btn);
    if (offer !== null) {
      const note = document.createElement("p");
      note.className = "sub";
      note.textContent = `Buyer's latest price: ${offer} CR. Accepting at the same price is rejected — name your counter.`;
      bar.prepend(note);
    }
  } else if (deal.state === "ESCROW_LOCKED") {
    const btn = document.createElement("button");
    btn.textContent = "Deliver Work";
    btn.addEventListener("click", async () => {
      try {
        // Async inspection: 202 parks the deal in VERIFYING and the AI
        // Inspector settles it in the background. The deliverable reference
        // is opaque — the server never fetches it in this slice.
        const deliveryId = `del-${Date.now()}`;
        await api(`/api/deals/${encodeURIComponent(deal.id)}/delivery`, {
          method: "POST",
          body: { id: deliveryId, dealId: deal.id, deliveryUrl: `deliverable:${deliveryId}` },
        });
        $("detail").textContent = `Delivery ${deliveryId} accepted for inspection (202). The deal settles automatically on a valid verdict.`;
        await load();
      } catch (err) {
        $("detail").textContent = `Delivery failed: ${err.message}`;
      }
    });
    bar.append(btn);
  } else if (deal.state === "AGREED") {
    const note = document.createElement("p");
    note.className = "sub";
    note.textContent = "Awaiting buyer payment — delivery unlocks once the escrow is captured.";
    bar.append(note);
  } else if (deal.state === "VERIFYING") {
    const banner = document.createElement("div");
    banner.className = "verify-banner";
    banner.setAttribute("data-deal-id", deal.id);
    banner.setAttribute("data-state", "VERIFYING");
    const pulse = document.createElement("span");
    pulse.className = "pulse";
    pulse.textContent = "Awaiting Meta Vision Inspector…";
    banner.append(pulse);
    bar.append(banner);
  }
}

$("gate-login").addEventListener("click", async () => {
  const id = $("seller-id").value.trim();
  const key = $("seller-key").value.trim();
  $("gate-error").textContent = "";
  if (id === "" || key === "") {
    $("gate-error").textContent = "Agent ID and API key are both required.";
    return;
  }
  try {
    // The listing proves the key: sellers see their own deals, anyone else
    // gets 401 and stays at the gate.
    await api("/api/deals", { key });
    try {
      sessionStorage.setItem(SELLER_KEY, JSON.stringify({ id, key }));
    } catch {
      $("gate-error").textContent = "This browser blocks tab storage, so the session cannot persist.";
      return;
    }
    $("gate").hidden = true;
    $("board").hidden = false;
    $("logout").hidden = false;
    await load();
  } catch (err) {
    $("gate-error").textContent = err.message;
  }
});

$("logout").addEventListener("click", logout);

// Add New Listing modal: Meta Blue card, same storefront bounds as the
// protocol schema. The listing registers under the seller's namespace
// (`seller-id:slug`) and enters the operator review queue like any agent.
$("new-listing-btn").addEventListener("click", () => {
  $("listing-error").textContent = "";
  $("listing-modal").hidden = false;
});

$("listing-close").addEventListener("click", () => {
  $("listing-modal").hidden = true;
});

$("listing-submit").addEventListener("click", async () => {
  const me = identity();
  if (me === null) return;
  const title = $("listing-title").value.trim();
  const description = $("listing-desc").value.trim();
  const category = $("listing-category").value;
  const price = Number($("listing-price").value);
  $("listing-error").textContent = "";
  if (title.length < 5 || title.length > 60) {
    $("listing-error").textContent = "Title must be 5–60 characters.";
    return;
  }
  if (description.length < 20 || description.length > 250) {
    $("listing-error").textContent = "Description must be 20–250 characters.";
    return;
  }
  if (!Number.isInteger(price) || price < 1 || price > 100000) {
    $("listing-error").textContent = "Price must be a whole number from 1 to 100000 CR.";
    return;
  }
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "listing";
  try {
    const data = await api("/api/agents", {
      method: "POST",
      body: { id: `${me.id}:${slug}-${Date.now().toString(36)}`, role: "seller", title, description, price, category },
    });
    $("listing-modal").hidden = true;
    $("listing-title").value = "";
    $("listing-desc").value = "";
    $("listing-error").textContent = "";
    $("detail").textContent =
      `Listing ${data.result.agent.id} registered and queued for operator approval. ` +
      `Manage it with API key: ${data.result.api_key} (shown once).`;
    await load();
  } catch (err) {
    $("listing-error").textContent = err.message;
  }
});

if (identity() !== null) {
  $("gate").hidden = true;
  $("board").hidden = false;
  $("logout").hidden = false;
  load().catch((err) => {
    $("detail").textContent = err.message;
  });
}
