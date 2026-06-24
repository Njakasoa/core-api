import type { MiddlewareHandler } from "hono";
import { env } from "../env.ts";
import { errors } from "../lib/errors.ts";

/**
 * Fixed-window rate limiter, in-memory (per process). Good enough for a
 * single instance; for multi-instance hyperscale, swap the `store` for Redis
 * (same interface: incr + ttl). Keyed by API key / user / client IP.
 */
interface Bucket {
  count: number;
  resetAt: number;
}
const store = new Map<string, Bucket>();

function clientKey(c: Parameters<MiddlewareHandler>[0]): string {
  const auth = c.get("auth");
  if (auth?.kind === "apiKey") return `key:${auth.apiKeyId}`;
  if (auth?.kind === "user") return `user:${auth.userId}`;
  const fwd = c.req.header("x-forwarded-for");
  const ip = fwd?.split(",")[0]?.trim() || "unknown";
  return `ip:${ip}`;
}

export const rateLimit: MiddlewareHandler = async (c, next) => {
  const now = Date.now();
  const windowMs = env.RATE_LIMIT_WINDOW * 1000;
  const key = clientKey(c);

  let bucket = store.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    store.set(key, bucket);
  }
  bucket.count++;

  const remaining = Math.max(0, env.RATE_LIMIT_MAX - bucket.count);
  c.header("RateLimit-Limit", String(env.RATE_LIMIT_MAX));
  c.header("RateLimit-Remaining", String(remaining));
  c.header("RateLimit-Reset", String(Math.ceil((bucket.resetAt - now) / 1000)));

  if (bucket.count > env.RATE_LIMIT_MAX) {
    throw errors.tooManyRequests();
  }
  await next();
};

// Periodically evict stale buckets so the map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of store) if (b.resetAt <= now) store.delete(k);
}, 60_000).unref?.();
