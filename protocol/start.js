import "dotenv/config";
import { mkdirSync } from "node:fs";
import path from "node:path";
import path from "node:path";
import { startServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? "data/bazaar.db";

const dbDir = path.dirname(DB_PATH);
mkdirSync(dbDir, { recursive: true });

const { close } = await startServer({ dbPath: DB_PATH, port: PORT });

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
  await close();
  process.exit(0);
});
