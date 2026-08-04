import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { rateLimit } from "./rate-limit.ts";
import { signAccessToken } from "../lib/jwt.ts";
import { onError } from "./error-handler.ts";

/**
 * These tests exist because the two defects they cover were INVISIBLE: the
 * limiter reported "keyed by API key / user / client IP" in its own docstring
 * while bucketing everything by a spoofable IP. Nothing failed, no log said
 * anything, and the API looked protected.
 *
 * Rather than assert a bucket key — which would just restate the implementation
 * — each test asserts what an attacker or a user would actually observe:
 * whether two requests share a budget. `RateLimit-Remaining` is that budget seen
 * from outside, so the tests read only what a client can read.
 *
 * Every test uses its own addresses and identities: the store is a module-level
 * Map that outlives a single test.
 */
const app = new Hono();
app.use("*", rateLimit);
// The real error handler, so an exhausted budget surfaces as the 429 a caller
// would actually receive. Without it the thrown AppError becomes a bare 500 and
// the test would pass or fail for the wrong reason.
app.onError(onError);
app.get("/", (c) => c.text("ok"));

/** Remaining budget after this call — what the caller sees. */
async function remaining(headers: Record<string, string>): Promise<number> {
  const res = await app.request("/", { headers });
  return Number(res.headers.get("RateLimit-Remaining"));
}

describe("client address", () => {
  test("a forged first hop does NOT buy a fresh bucket", async () => {
    // One real client behind our proxy, changing the hop it writes each time.
    // Before the fix each of these was a brand-new bucket, and the limiter was
    // simply bypassable by anyone who set the header.
    const a = await remaining({ "x-forwarded-for": "10.0.0.1, 203.0.113.7" });
    const b = await remaining({ "x-forwarded-for": "10.0.0.2, 203.0.113.7" });
    const c = await remaining({ "x-forwarded-for": "evil, 203.0.113.7" });
    expect(b).toBe(a - 1);
    expect(c).toBe(a - 2);
  });

  test("two real clients behind the same proxy keep separate budgets", async () => {
    const a = await remaining({ "x-forwarded-for": "203.0.113.10" });
    const b = await remaining({ "x-forwarded-for": "203.0.113.11" });
    // Independent buckets: the second client is untouched by the first.
    expect(b).toBe(a);
  });

  test("cf-connecting-ip is not trusted", async () => {
    // Cloudflare is DNS-only for this API, so nothing upstream sets or strips
    // this header: it is whatever the caller typed. Honouring it would reopen
    // the same hole under a different name — two callers claiming different
    // Cloudflare addresses must still share the bucket of the address our own
    // proxy actually saw.
    const real = "203.0.113.30";
    const a = await remaining({ "x-forwarded-for": real, "cf-connecting-ip": "1.1.1.1" });
    const b = await remaining({ "x-forwarded-for": real, "cf-connecting-ip": "2.2.2.2" });
    expect(b).toBe(a - 1);
  });
});

describe("principal", () => {
  test("a signed-in user is billed to their account, not to their address", async () => {
    // The branch that was dead code: the limiter runs before requireAuth, so it
    // has to resolve the token itself or it never sees a user at all.
    const token = await signAccessToken("user_rl_moving");
    const h = { Authorization: `Bearer ${token}` };
    const a = await remaining({ ...h, "x-forwarded-for": "198.51.100.1" });
    const b = await remaining({ ...h, "x-forwarded-for": "198.51.100.2" });
    // Same person, two addresses, one budget — moving network must not reset it.
    expect(b).toBe(a - 1);
  });

  test("two users sharing one address do not spend each other's budget", async () => {
    const one = await signAccessToken("user_rl_shared_one");
    const two = await signAccessToken("user_rl_shared_two");
    const ip = "198.51.100.50";
    const a = await remaining({ Authorization: `Bearer ${one}`, "x-forwarded-for": ip });
    const b = await remaining({ Authorization: `Bearer ${two}`, "x-forwarded-for": ip });
    // A shared office or a phone network must not throttle everyone at once.
    expect(b).toBe(a);
  });

  test("an API key gets its own budget without a database lookup", async () => {
    const h = { Authorization: "Bearer sk_ratelimit_test_key" };
    const a = await remaining({ ...h, "x-forwarded-for": "198.51.100.70" });
    const b = await remaining({ ...h, "x-forwarded-for": "198.51.100.71" });
    expect(b).toBe(a - 1);
  });

  test("a junk token cannot mint a fresh bucket", async () => {
    // The obvious way to reopen the hole: send an unparseable token each time.
    // These must all land in the caller's IP bucket.
    const ip = "198.51.100.90";
    const a = await remaining({ Authorization: "Bearer not-a-jwt-1", "x-forwarded-for": ip });
    const b = await remaining({ Authorization: "Bearer not-a-jwt-2", "x-forwarded-for": ip });
    const c = await remaining({ "x-forwarded-for": ip });
    expect(b).toBe(a - 1);
    expect(c).toBe(a - 2);
  });
});

describe("the window still closes", () => {
  test("the budget runs out and the request is refused", async () => {
    const ip = "198.51.100.200";
    let res: Response | undefined;
    // Spend the window. Bounded well above RATE_LIMIT_MAX so the loop cannot
    // run away if the setting changes.
    for (let i = 0; i < 100_000; i++) {
      res = await app.request("/", { headers: { "x-forwarded-for": ip } });
      if (res.status === 429) break;
    }
    expect(res?.status).toBe(429);
  }, 30_000);
});
