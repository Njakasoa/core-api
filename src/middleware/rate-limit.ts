import type { MiddlewareHandler } from "hono";
import { env } from "../env.ts";
import { errors } from "../lib/errors.ts";
import { sha256 } from "../lib/crypto.ts";
import { verifyAccessToken } from "../lib/jwt.ts";
import { API_KEY_PREFIX } from "./auth.ts";

/**
 * Fixed-window rate limiter, in-memory (per process). Good enough for a
 * single instance; for multi-instance hyperscale, swap the `store` for Redis
 * (same interface: incr + ttl). Keyed by API key / user / client IP.
 *
 * TWO DEFECTS THIS FILE USED TO HAVE, AND WHY THEY MATTERED
 *
 * 1. The per-principal keys were dead code. This middleware is mounted globally
 *    (`app.use("/v1/*", rateLimit)` in app.ts) while `requireAuth` is mounted
 *    INSIDE each route factory. Global middleware runs first, so `c.get("auth")`
 *    was always undefined here and both the `key:` and `user:` branches were
 *    unreachable. Every request in the API was bucketed by IP — while the
 *    comment above claimed otherwise, which is the worse half of the bug.
 *
 * 2. The IP came from the FIRST hop of `x-forwarded-for`, a header the caller
 *    writes. Rotating it handed out a fresh bucket per request, so the limiter
 *    could be stepped around by anyone who thought to try.
 *
 * Both are fixed below. The principal is resolved here, WITHOUT a database
 * round-trip, so the limiter stays cheap enough to keep on the global path.
 */
interface Bucket {
  count: number;
  resetAt: number;
}
const store = new Map<string, Bucket>();

/**
 * The client address, taken from the RIGHT of `x-forwarded-for`.
 *
 * Each proxy APPENDS the peer it saw, so the last entry is the one our own
 * front door observed and the only one the caller cannot forge. Everything to
 * its left may have been written by the client. `TRUSTED_PROXY_HOPS` says how
 * many appenders sit in front of us — 1 for the Caddy in deploy/Caddyfile.example.
 *
 * Cloudflare is DNS-only for api.njakasoa.xyz: it resolves the name and is NOT
 * in the request path, so it appends nothing and the count stays 1. Were the
 * proxy ever switched on, Cloudflare would append to this same header, so the
 * fix is the hop count and nothing else.
 *
 * `cf-connecting-ip` is deliberately NOT consulted. With the proxy off, nothing
 * upstream sets or strips it, so it is a header the caller writes — trusting it
 * would reopen, under another name, exactly the hole this function closes. And
 * with the proxy on it would be redundant, since the hop count already covers it.
 *
 * If the header carries fewer hops than configured, the request did not come
 * through the expected chain. We clamp to the first entry rather than reject:
 * that is the old behaviour, so a misconfigured hop count degrades to what the
 * API already did instead of bucketing every visitor together.
 */
function trustedIp(c: Parameters<MiddlewareHandler>[0]): string {
  const fwd = c.req.header("x-forwarded-for");
  if (!fwd) return "unknown";
  const hops = fwd
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (hops.length === 0) return "unknown";
  return hops[Math.max(0, hops.length - env.TRUSTED_PROXY_HOPS)] ?? "unknown";
}

/**
 * The bucket key for this caller.
 *
 * Resolves the principal itself, because the limiter runs before `requireAuth`.
 * Neither branch touches the database: an API key is bucketed by the hash of the
 * token — which identifies it uniquely without resolving it — and a JWT is
 * checked against the shared secret, which is a signature verification, not a
 * lookup.
 *
 * An invalid or expired token falls through to the IP bucket on purpose.
 * Otherwise sending garbage in the Authorization header would mint a fresh
 * bucket per request, which is the very hole being closed here.
 */
/**
 * Stored objects get their own bucket, and it is not an exemption.
 *
 * A viewer opening one book asks for up to 166 thumbnails in a burst, which the
 * shared 120/min bucket would cut off mid-grid — and would then also lock the
 * visitor out of every other endpoint for the rest of the window, because it is
 * one counter. So bytes move to a bucket of their own. The same holds for any
 * future feature that renders a gallery: this is a property of serving files,
 * not of the bibliothèque, which is why the path is `/v1/objets/` and not one
 * feature's sub-route.
 *
 * Not exempted, though: `GET /v1/objets/:sha256` is unauthenticated and reads a
 * whole `bytea` row (or does a round trip to R2) per request. An exemption there
 * is an unmetered egress tap. Keyed by IP alone, since an <img> tag carries no
 * token and every reader looks anonymous here.
 */
const CHEMIN_OBJETS = "/v1/objets/";

async function clientKey(c: Parameters<MiddlewareHandler>[0]): Promise<string> {
  if (c.req.path.startsWith(CHEMIN_OBJETS)) return `img:${trustedIp(c)}`;

  // Honoured if the limiter is ever mounted after requireAuth on some route.
  const auth = c.get("auth");
  if (auth?.kind === "apiKey") return `key:${auth.apiKeyId}`;
  if (auth?.kind === "user") return `user:${auth.userId}`;

  const header = c.req.header("Authorization");
  if (header?.startsWith("Bearer ")) {
    const token = header.slice(7).trim();
    if (token.startsWith(API_KEY_PREFIX)) return `key:${sha256(token).slice(0, 32)}`;
    const claims = await verifyAccessToken(token);
    if (claims) return `user:${claims.sub}`;
  }
  return `ip:${trustedIp(c)}`;
}

export const rateLimit: MiddlewareHandler = async (c, next) => {
  const now = Date.now();
  const windowMs = env.RATE_LIMIT_WINDOW * 1000;
  const key = await clientKey(c);
  const max = key.startsWith("img:") ? env.RATE_LIMIT_IMAGES_MAX : env.RATE_LIMIT_MAX;

  let bucket = store.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    store.set(key, bucket);
  }
  bucket.count++;

  const remaining = Math.max(0, max - bucket.count);
  c.header("RateLimit-Limit", String(max));
  c.header("RateLimit-Remaining", String(remaining));
  c.header("RateLimit-Reset", String(Math.ceil((bucket.resetAt - now) / 1000)));

  if (bucket.count > max) {
    throw errors.tooManyRequests();
  }
  await next();
};

// Periodically evict stale buckets so the map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of store) if (b.resetAt <= now) store.delete(k);
}, 60_000).unref?.();
