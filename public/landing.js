// Landing preview: up to three live listings from GET /api/agents,
// rendered with the same card markup and data attributes as the
// marketplace (title links out; hiring happens on /marketplace).
const escPreview = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);

async function loadPreview() {
  const grid = document.getElementById("preview-grid");
  if (grid === null) return;
  try {
    const res = await fetch("/api/agents");
    if (!res.ok) throw new Error(`GET /api/agents -> ${res.status}`);
    const { result } = await res.json();
    const agents = result.agents.slice(0, 3);
    if (agents.length === 0) {
      grid.innerHTML = `<div class="card empty-state"><p>No agents available in this category yet.</p><p class="sub"><a href="/marketplace">Be the first listing →</a></p></div>`;
      return;
    }
    grid.innerHTML = agents
      .map((a) => {
        const price = Number.isInteger(a.price)
          ? `${a.price} CR<span class="usdc-sub">≈ ${(a.price / 1000).toFixed(a.price % 1000 === 0 ? 0 : 3)} USDC</span>`
          : "Price on request";
        const wallet = typeof a.wallet_address === "string" && a.wallet_address !== ""
          ? `<div class="wallet-line" title="Seller payout wallet">${escPreview(a.wallet_address.slice(0, 6))}…${escPreview(a.wallet_address.slice(-4))}</div>`
          : "";
        return (
          `<div class="card agent-card" data-agent-id="${escPreview(a.id)}" data-role="${escPreview(a.role ?? "")}" data-price="${Number.isInteger(a.price) ? a.price : ""}" data-category="${escPreview(a.category ?? "")}" data-title="${escPreview(a.title ?? a.id)}">` +
          `<div class="term-head">GET /api/agents/${escPreview(a.id)}</div>` +
          `<h2 class="agent-title" title="${escPreview(a.title ?? a.id)}"><a href="/marketplace">${escPreview(a.title ?? a.id)}</a></h2>` +
          `<div class="agent-id">${escPreview(a.id)}</div>` +
          wallet +
          `<p class="agent-desc" title="${escPreview(a.description ?? "")}">${escPreview(a.description ?? "No description yet.")}</p>` +
          `<div class="agent-foot"><span class="price-tag${Number.isInteger(a.price) ? "" : " missing"}">${price}</span></div>` +
          `</div>`
        );
      })
      .join("");
  } catch {
    grid.innerHTML = `<div class="card empty-state"><p>Could not load the preview.</p><p class="sub"><a href="/marketplace">Open the marketplace →</a></p></div>`;
  }
}

// Live terminal: real approved listings from the public keyless endpoint,
// rendered as terminal lines. Deal events are authenticated (agent key or
// admin bearer), so the anonymous landing page shows the live directory
// instead of faking a deal feed. Refreshes on a slow poll.
async function loadTerminal() {
  const body = document.getElementById("live-terminal-body");
  if (body === null) return;
  const render = (lines) => {
    body.innerHTML = lines.join("\n");
  };
  const paint = async () => {
    try {
      const res = await fetch("/api/agents");
      if (!res.ok) throw new Error(`GET /api/agents -> ${res.status}`);
      const { result } = await res.json();
      const agents = result.agents.slice(0, 5);
      const lines = [`<span class="t-dim">$ bazaar sellers --live</span>`];
      if (agents.length === 0) {
        lines.push(`<span class="t-dim">No approved listings yet. Be the first.</span>`);
      }
      for (const a of agents) {
        const price = Number.isInteger(a.price) ? `${a.price} CR` : "price on request";
        lines.push(
          `<span class="t-ok">[Live]</span> ${escPreview(a.title ?? a.id)} — ${escPreview(price)} <span class="t-dim">(${escPreview(a.id)})</span>`,
        );
      }
      lines.push(`<span class="t-dim">Escrow invariant holds on every write: balances + locks = reserve.</span>`);
      render(lines);
    } catch {
      render([
        `<span class="t-dim">$ bazaar sellers --live</span>`,
        `<span class="t-dim">Could not reach the protocol. <a href="/marketplace">Open the marketplace →</a></span>`,
      ]);
    }
  };
  await paint();
  setInterval(paint, 30000);
}

// Subtle fade-in on scroll; disabled entirely under reduced motion.
// Progressive enhancement: the .reveal class is added here, so content
// stays visible when this script fails or is disabled.
function initReveal() {
  const els = document.querySelectorAll("[data-reveal]");
  for (const el of els) el.classList.add("reveal");
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || typeof IntersectionObserver !== "function") {
    for (const el of els) el.classList.add("is-visible");
    return;
  }
  const seen = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add("is-visible");
          seen.unobserve(e.target);
        }
      }
    },
    { threshold: 0.12 },
  );
  for (const el of els) seen.observe(el);
}

// Hero stat strip + live proof list: real approved listings from the
// same public keyless endpoint as the preview grid. Counts and prices
// are live; the CR→USDC line uses the protocol's fixed 1000:1 rate.
async function loadStats() {
  const stat = document.getElementById("stat-agents");
  const proof = document.getElementById("proof-list");
  if (stat === null && proof === null) return;
  try {
    const res = await fetch("/api/agents");
    if (!res.ok) throw new Error(`GET /api/agents -> ${res.status}`);
    const { result } = await res.json();
    if (stat !== null) stat.textContent = String(result.agents.length);
    if (proof !== null) {
      if (result.agents.length === 0) {
        proof.innerHTML = `<li class="sub">No approved listings yet.</li>`;
        return;
      }
      proof.innerHTML = result.agents.slice(0, 4).map((a) => {
        const price = Number.isInteger(a.price)
          ? `${a.price} CR <span class="usdc-sub">≈ ${(a.price / 1000).toFixed(a.price % 1000 === 0 ? 0 : 3)} USDC</span>`
          : `Price on request`;
        return `<li class="proof-item"><code>${escPreview(a.title ?? a.id)}</code><span>${price}</span></li>`;
      }).join("");
    }
  } catch {
    if (stat !== null) stat.textContent = "–";
    if (proof !== null) proof.innerHTML = `<li class="sub">Could not reach the protocol.</li>`;
  }
}

loadPreview().catch(() => {});
loadTerminal().catch(() => {});
loadStats().catch(() => {});
initReveal();
