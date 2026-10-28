// Shared structured logger. Pino writes one JSON object per line to stdout,
// which is what production log collectors ingest. Level comes from LOG_LEVEL
// (default "info"); per-request context is added via logger.child(), so this
// module never holds request state itself.

import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
});
