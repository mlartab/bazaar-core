// Bazaar shared frontend helpers. Loaded BEFORE page scripts via
// <script src="/utils.js"></script>; every helper hangs off globalThis so
// pages alias it with a standalone fallback (tests run page scripts alone).
globalThis.$ = (id) => document.getElementById(id);

globalThis.esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);

// kind-aware toast: admin holder style when #toasts exists, fixed pill
// fallback otherwise (marketplace / buyer pages).
globalThis.toast = function toast(message, kind = "info") {
  const holder = typeof document !== "undefined" ? document.getElementById("toasts") : null;
  if (holder !== null) {
    const el = document.createElement("div");
    el.className = `toast toast-${kind}`;
    el.textContent = message;
    holder.appendChild(el);
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => fn();
    raf(() => el.classList.add("show"));
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 300);
    }, 4200);
    return;
  }
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
};

globalThis.apiGet = async function apiGet(path, agentKey) {
  const headers = {};
  if (agentKey !== undefined) headers["x-agent-key"] = agentKey;
  const res = await fetch(path, { headers });
  const data = await res.json();
  if (!res.ok || data.ok !== true) {
    throw new Error(`${data.error?.code ?? res.status}: ${data.error?.message ?? "request failed"}`);
  }
  return data;
};

globalThis.apiPost = async function apiPost(path, body, agentKey, { idempotency = true } = {}) {
  const headers = { "content-type": "application/json" };
  if (idempotency) headers["idempotency-key"] = crypto.randomUUID();
  if (agentKey !== undefined) headers["x-agent-key"] = agentKey;
  const res = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok || data.ok !== true) {
    throw new Error(`${data.error?.code ?? res.status}: ${data.error?.message ?? "request failed"}`);
  }
  return data;
};

// Protocol rate: 1000 CR = 1 USDC on Base Sepolia. Display-only math.
globalThis.usdcSub = function usdcSub(price) {
  if (!Number.isInteger(price)) return "";
  const whole = Math.trunc(price / 1000);
  const frac = String(price % 1000).padStart(3, "0").replace(/0+$/, "");
  return `<span class="usdc-sub">≈ ${whole}${frac === "" ? "" : `.${frac}`} USDC · Base Sepolia</span>`;
};

globalThis.priceTag = function priceTag(price) {
  if (Number.isInteger(price)) {
    return `<span class="price-tag">${price} CR${globalThis.usdcSub(price)}</span>`;
  }
  return `<span class="price-tag missing">Price on request</span>`;
};

// Basescan link for a verified chain hash. Anything else renders nothing.
globalThis.txLink = function txLink(hash) {
  if (typeof hash !== "string" || !hash.startsWith("0x")) return "";
  return `<a class="tx-link" href="https://sepolia.basescan.org/tx/${globalThis.esc(hash)}" target="_blank" rel="noopener">${globalThis.esc(hash.slice(0, 6))}…${globalThis.esc(hash.slice(-4))} ↗</a>`;
};

globalThis.truncateAddress = function truncateAddress(address) {
  return `${address.slice(0, 4)}...${address.slice(-2)}`;
};
