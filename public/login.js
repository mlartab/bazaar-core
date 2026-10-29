// Gatekeeper for the admin console. No sessions: the secret lives in
// localStorage and every admin call carries it as a Bearer header.
// Validity is probed live against /api/admin/stats — a stored secret is
// trusted only after the server accepts it.
const SECRET_KEY = "bazaar-admin-secret";

const $ = (id) => document.getElementById(id);

async function probe(secret) {
  const res = await fetch("/api/admin/stats", {
    headers: { authorization: `Bearer ${secret}` },
  });
  return res.status === 200;
}

async function tryEnter(secret, note) {
  let ok = false;
  try {
    ok = await probe(secret);
  } catch {
    ok = false;
  }
  if (ok) {
    localStorage.setItem(SECRET_KEY, secret);
    location.href = "/admin";
  } else if (note) {
    note.textContent = "Invalid secret.";
  }
  return ok;
}

$("login").addEventListener("click", async () => {
  const secret = $("secret").value.trim();
  if (secret === "") return;
  $("secret").value = "";
  await tryEnter(secret, $("login-note"));
});

$("secret").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("login").click();
});

// Already authenticated? Skip the form entirely.
const stored = localStorage.getItem(SECRET_KEY);
if (stored) {
  $("login-note").textContent = "Checking saved secret…";
  tryEnter(stored, $("login-note"));
}
