import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("../public/marketplace.js", import.meta.url), "utf8");

function makeElement() {
  return {
    innerHTML: "",
    textContent: "",
    hidden: false,
    value: "",
    dataset: {},
    selectedOptions: [{ textContent: "Featured" }],
    querySelectorAll: () => [],
    addEventListener: () => {},
    setAttribute: () => {},
    scrollIntoView: () => {},
  };
}

// Runs the real marketplace.js against stub DOM/network (no UI launch).
// Returns the stub world after load() + loadMyDeals() settle.
async function runMarketplace() {
  const elements = new Map();
  const store = new Map();
  const seen = { provisioned: 0, dealsAuth: null };

  const documentStub = {
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, makeElement());
      return elements.get(id);
    },
    querySelector: () => null,
    createElement: () => makeElement(),
    body: { appendChild: () => {} },
  };

  const fetchStub = async (path, opts = {}) => {
    const method = (opts.method ?? "GET").toUpperCase();
    if (method === "POST" && path === "/api/agents") {
      seen.provisioned += 1;
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: { agent: { id: "guest-buyer-1" }, api_key: "buyer-key-1" },
        }),
      };
    }
    if (path.startsWith("/api/agents")) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: {
            agents: [
              {
                id: "legal-agent",
                title: "AI Image Gen",
                price: 60,
                role: "seller",
                category: "image_gen",
                service_type: "endpoint",
                skills: ["render"],
              },
            ],
          },
        }),
      };
    }
    if (path.startsWith("/api/deals")) {
      seen.dealsAuth = opts.headers?.["x-agent-key"] ?? null;
      return {
        ok: true,
        json: async () => ({ ok: true, result: { deals: [] } }),
      };
    }
    return { ok: false, status: 404, json: async () => ({ ok: false }) };
  };

  const sandbox = {
    document: documentStub,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    fetch: fetchStub,
    URLSearchParams,
    URL,
    crypto: { randomUUID: () => "test-uuid-1" },
    setTimeout: (fn) => 0,
    clearTimeout: () => {},
    prompt: () => null,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "marketplace.js" });
  await new Promise((r) => setTimeout(r, 50));
  return { elements, store, seen };
}

describe("marketplace.js frontend fixes", () => {
  it("initializes filters before the agents fetch", () => {
    const decl = SRC.search(/\b(const|let|var)\s+filters\s*=\s*\{[^}]*skill[^}]*service_type[^}]*\}/);
    assert.notEqual(decl, -1, "filters must be initialized with skill + service_type");
    const firstUse = SRC.search(/filters\.(service_type|skill|query|category|sort)/);
    assert.ok(decl < firstUse, "filters declaration must precede first use");
  });

  it("populates filters from the UI dropdowns before fetch", () => {
    assert.match(SRC, /market-service-type/);
    assert.match(SRC, /market-skill/);
    const loadBody = SRC.slice(SRC.indexOf("async function load()"));
    assert.match(
      loadBody,
      /readServerFilters\(\)[\s\S]{0,300}discoveryQuery\(\)/,
      "load() must sync dropdowns into filters before discoveryQuery()",
    );
  });

  it("renders the legal-agent card with title, price and Hire button", async () => {
    const { elements } = await runMarketplace();
    const grid = elements.get("agents").innerHTML;
    assert.ok(!grid.includes("filters is not defined"), "seller grid must not show the filters crash");
    assert.match(grid, /AI Image Gen/);
    assert.match(grid, /60 CR/);
    assert.match(grid, /Hire Agent/);
  });

  it("auto-provisions a guest buyer key instead of UNAUTHORIZED", async () => {
    const { store, seen, elements } = await runMarketplace();
    assert.equal(seen.provisioned, 1, "should POST /api/agents once to provision a guest buyer");
    assert.ok(store.has("bazaar-buyer-identity"), "buyer identity must be saved to localStorage");
    assert.equal(seen.dealsAuth, "buyer-key-1", "deals fetch must carry the provisioned key");
    const deals = elements.get("my-deals-body").innerHTML;
    assert.ok(!deals.includes("UNAUTHORIZED"), "deals panel must not show UNAUTHORIZED");
  });
});
