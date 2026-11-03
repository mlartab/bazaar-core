// Buyer dashboard: private deal list for the wallet-linked buyer identity.
// Moved from the public marketplace page so browsing stays anonymous.
// Identity, deal, and SIWE wallet logic mirror marketplace.js; element IDs
// (connect-wallet, wallet-dropdown, my-deals-body, …) are shared on purpose.
// Shared via utils.js in the browser; standalone fallbacks when run alone.
const $ = globalThis.$ ?? ((id) => document.getElementById(id));
const esc = globalThis.esc ?? ((value) => String(value ?? ""));
const toast = globalThis.toast ?? ((message) => {});

const BUYER_KEY = "bazaar-buyer-identity";

function buyerIdentity() {
  try {
    const parsed = JSON.parse(localStorage.getItem(BUYER_KEY) ?? "null");
    if (typeof parsed?.id === "string" && typeof parsed?.key === "string") return parsed;
  } catch {
    // Corrupt entry: fall through and re-provision.
  }
  return null;
}

const apiGet = globalThis.apiGet ?? (async () => { throw new Error("apiGet unavailable"); });
const apiPost = globalThis.apiPost ?? (async () => { throw new Error("apiPost unavailable"); });

function justDisconnected() {
  try {
    return sessionStorage.getItem("just_disconnected") === "true";
  } catch {
    return false;
  }
}

async function ensureBuyer() {
  const existing = buyerIdentity();
  if (existing !== null) return existing;
  // Post-disconnect: never silently mint a ghost buyer. The empty state
  // invites an explicit reconnect instead.
  if (justDisconnected()) throw new Error("Signed out");
  const data = await apiPost("/api/agents", { id: `web-buyer-${crypto.randomUUID()}`, role: "buyer" });
  const identity = { id: data.result.agent.id, key: data.result.api_key };
  try {
    localStorage.setItem(BUYER_KEY, JSON.stringify(identity));
  } catch {
    // Blocked storage: the hire still works this once, unremembered.
  }
  return identity;
}

const usdcSub = globalThis.usdcSub ?? ((price) => "");
const priceTag = globalThis.priceTag ?? ((price) => String(price ?? ""));
const txLink = globalThis.txLink ?? ((hash) => "");

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
  const funding = txLink(detail.pay_tx_hash ?? deal.pay_tx_hash);
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

function dealsEmptyHTML() {
  return `<div class="deals-empty"><svg width="44" height="44" viewBox="0 0 44 44" fill="none" aria-hidden="true"><rect x="6" y="14" width="32" height="20" rx="4" stroke="#94A3B8" stroke-width="2" stroke-dasharray="5 4"/><path d="M6 20h32" stroke="#94A3B8" stroke-width="2"/><circle cx="22" cy="29" r="3" stroke="#EA580C" stroke-width="2"/></svg><p>No deals yet. Browse the marketplace to hire a seller.</p><p><a href="/marketplace">Browse agents →</a></p></div>`;
}

function dealsSignedOutHTML() {
  return `<div class="deals-empty"><svg width="44" height="44" viewBox="0 0 44 44" fill="none" aria-hidden="true"><rect x="6" y="14" width="32" height="20" rx="4" stroke="#94A3B8" stroke-width="2" stroke-dasharray="5 4"/><path d="M6 20h32" stroke="#94A3B8" stroke-width="2"/><circle cx="22" cy="29" r="3" stroke="#EA580C" stroke-width="2"/></svg><p>You are signed out. Connect your wallet to view your deals.</p></div>`;
}

async function loadMyDeals() {
  const body = $("my-deals-body");
  if (body === null) return;
  if (justDisconnected()) {
    body.innerHTML = dealsSignedOutHTML();
    return;
  }
  let buyer = buyerIdentity();
  if (buyer === null) {
    try {
      buyer = await ensureBuyer();
    } catch {
      body.innerHTML = dealsEmptyHTML();
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
    body.innerHTML = dealsEmptyHTML();
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

const buyerDealsBody = $("my-deals-body");
if (buyerDealsBody !== null) buyerDealsBody.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-pay],[data-offer],[data-accept]");
  if (btn === null) return;
  if (btn.hasAttribute("data-pay")) payDeal(btn.dataset.pay);
  else if (btn.hasAttribute("data-offer")) offerDeal(btn.dataset.offer);
  else if (btn.hasAttribute("data-accept")) acceptDeal(btn.dataset.accept, Number(btn.dataset.price));
});

const buyerDealsToggle = $("my-deals-toggle");
if (buyerDealsToggle !== null) buyerDealsToggle.addEventListener("click", () => {
  const body = $("my-deals-body");
  if (body === null) return;
  const hidden = body.hidden;
  body.hidden = !hidden;
  buyerDealsToggle.textContent = hidden ? "Show" : "Hide";
  buyerDealsToggle.setAttribute("aria-expanded", String(hidden));
});

// Wallet balance card: live buyer balance from GET /api/me.
async function fillBuyerBalance() {
  const addrEl = $("buyer-addr");
  const balEl = $("buyer-balance");
  const stored = buyerIdentity();
  if (addrEl !== null) addrEl.textContent = stored?.wallet ?? stored?.id ?? "—";
  if (balEl === null || stored === null) return;
  try {
    const me = await apiGet("/api/me", stored.key);
    const bal = me.result?.balance;
    balEl.textContent = `CR Balance: ${Number.isInteger(bal) ? `${bal} CR` : "—"}`;
  } catch {
    balEl.textContent = "CR Balance: —";
  }
}

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
    await fillBuyerBalance().catch(() => {});
  } catch (err) {
    toast(err?.message ?? String(err));
  }
}

{
  const btn = document.getElementById("connect-wallet");
  if (btn !== null) btn.addEventListener("click", () => {
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
      // Blocked storage: the redirect below still drops the session.
    }
    try {
      sessionStorage.setItem("just_disconnected", "true");
    } catch {
      // Blocked storage: the redirect still lands on a signed-out page.
    }
    toast("Wallet disconnected.");
    window.location.assign("/marketplace");
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

loadMyDeals();
fillBuyerBalance();
