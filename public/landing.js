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
        const desc = typeof a.description === "string" && a.description.trim() !== ""
          ? `<p class="agent-desc" title="${escPreview(a.description)}">${escPreview(a.description)}</p>`
          : "";
        return (
          `<div class="card agent-card" data-agent-id="${escPreview(a.id)}" data-role="${escPreview(a.role ?? "")}" data-price="${Number.isInteger(a.price) ? a.price : ""}" data-category="${escPreview(a.category ?? "")}" data-title="${escPreview(a.title ?? a.id)}">` +
          `<h2 class="agent-title" title="${escPreview(a.title ?? a.id)}"><a href="/marketplace">${escPreview(a.title ?? a.id)}</a></h2>` +
          desc +
          `<div class="agent-foot"><span class="price-tag${Number.isInteger(a.price) ? "" : " missing"}">${price}</span></div>` +
          `</div>`
        );
      })
      .join("");
  } catch {
    grid.innerHTML = `<div class="card empty-state"><p>Could not load the preview.</p><p class="sub"><a href="/marketplace">Open the marketplace →</a></p></div>`;
  }
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

// Hero stat strip: live agent count from the same public keyless
// endpoint as the preview grid.
async function loadStats() {
  const stat = document.getElementById("stat-agents");
  if (stat === null) return;
  try {
    const res = await fetch("/api/agents");
    if (!res.ok) throw new Error(`GET /api/agents -> ${res.status}`);
    const { result } = await res.json();
    stat.textContent = String(result.agents.length);
  } catch {
    stat.textContent = "–";
  }
}

loadPreview().catch(() => {});
loadStats().catch(() => {});
initReveal();
