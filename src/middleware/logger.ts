import type { MiddlewareHandler } from "hono";
import { env } from "../env.ts";

/** Minimal structured request logger (JSON lines). Quiet during tests. */
export const logger: MiddlewareHandler = async (c, next) => {
  if (env.NODE_ENV === "test") return next();
  const start = performance.now();
  await next();
  const ms = Math.round((performance.now() - start) * 10) / 10;
  const line = {
    t: new Date().toISOString(),
    id: c.get("requestId"),
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    ms,
  };
  console.log(JSON.stringify(line));
};
