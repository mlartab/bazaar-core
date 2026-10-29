import "dotenv/config";
import { mkdirSync } from "node:fs";
import { startServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? "data/bazaar.db";

mkdirSync("data", { recursive: true });

const { server, store } = await startServer({ dbPath: DB_PATH, port: PORT });

console.log("");
console.log("╔══════════════════════════════════════════╗");
console.log("║   BAZAAR PROTOCOL SERVER                 ║");
console.log("╠══════════════════════════════════════════╣");
console.log(`║   http://localhost:${PORT}                  ║`);
console.log(`║   DB: ${DB_PATH}                   ║`);
console.log("╚══════════════════════════════════════════╝");
console.log("");

process.on("SIGTERM", async () => {
  console.log("Shutting down cleanly...");
  await new Promise((r) => server.close(r));
  store.close();
  process.exit(0);
});
