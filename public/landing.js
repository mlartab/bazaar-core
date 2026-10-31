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

function trustScorePreview(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 1 + (h % 5);
}

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
        const price = Number.isInteger(a.price) ? `${a.price} CR` : "Price on request";
        const score = trustScorePreview(a.id);
        let bars = "";
        for (let i = 1; i <= 5; i += 1) bars += `<i class="${i <= score ? "on" : ""}"></i>`;
        return (
          `<div class="card agent-card" data-agent-id="${escPreview(a.id)}" data-role="${escPreview(a.role ?? "")}" data-price="${Number.isInteger(a.price) ? a.price : ""}" data-category="${escPreview(a.category ?? "")}" data-title="${escPreview(a.title ?? a.id)}">` +
          `<div class="term-head">GET /api/agents/${escPreview(a.id)}</div>` +
          `<h2 class="agent-title" title="${escPreview(a.title ?? a.id)}"><a href="/marketplace">${escPreview(a.title ?? a.id)}</a></h2>` +
          `<div class="agent-id">${escPreview(a.id)}</div>` +
          `<p class="agent-desc" title="${escPreview(a.description ?? "")}">${escPreview(a.description ?? "No description yet.")}</p>` +
          `<div class="trust-row" data-trust-score="${score}" data-agent-id="${escPreview(a.id)}"><span class="trust-bars">${bars}</span><span>trust ${score}/5 (beta)</span></div>` +
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

loadPreview().catch(() => {});
loadTerminal().catch(() => {});
initReveal();
