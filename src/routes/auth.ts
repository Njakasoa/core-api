import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { and, eq, isNull, gt } from "drizzle-orm";
import { db } from "../db/index.ts";
import { users, orgs, orgMembers, refreshTokens } from "../db/schema.ts";
import type { Variables } from "../types.ts";
import { hashPassword, verifyPassword, sha256 } from "../lib/crypto.ts";
import { id, randomToken } from "../lib/ids.ts";
import { signAccessToken } from "../lib/jwt.ts";
import {
  newTotpSecret,
  totpProvisioning,
  verifyTotp,
  newRecoveryCodes,
} from "../lib/totp.ts";
import { errors } from "../lib/errors.ts";
import { validate } from "../lib/validate.ts";
import { requireAuth } from "../middleware/auth.ts";
import { env } from "../env.ts";

const credentials = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
});
const registerBody = credentials.extend({
  name: z.string().min(1).max(120).optional(),
});
const loginBody = credentials.extend({
  totp: z.string().length(6).optional(),
});

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "org"
  );
}

/** Issue an access token + a freshly persisted (hashed) refresh token. */
async function issueSession(userId: string) {
  const accessToken = await signAccessToken(userId);
  const refresh = `rt_${randomToken(32)}`;
  await db.insert(refreshTokens).values({
    id: id("rtk"),
    userId,
    tokenHash: sha256(refresh),
    expiresAt: new Date(Date.now() + env.REFRESH_TTL * 1000),
  });
  return { accessToken, refreshToken: refresh, expiresIn: env.ACCESS_TTL };
}

export function authRoute(): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.post(
    "/register",
    describeRoute({ description: "Register and create a default org", tags: ["auth"] }),
    validate("json", registerBody),
    async (c) => {
      const { email, password, name } = c.req.valid("json");

      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email.toLowerCase()))
        .limit(1);
      if (existing) throw errors.conflict("Email already registered");

      const userId = id("user");
      const orgId = id("org");
      await db.transaction(async (tx) => {
        await tx.insert(users).values({
          id: userId,
          email: email.toLowerCase(),
          passwordHash: await hashPassword(password),
          name: name ?? null,
        });
        await tx
          .insert(orgs)
          .values({ id: orgId, name: name ? `${name}'s org` : "My org", slug: slugify(email) });
        await tx
          .insert(orgMembers)
          .values({ id: id("mem"), orgId, userId, role: "owner" });
      });

      const session = await issueSession(userId);
      return c.json(
        { user: { id: userId, email: email.toLowerCase(), name: name ?? null }, org: { id: orgId }, ...session },
        201,
      );
    },
  );

  app.post(
    "/login",
    describeRoute({ description: "Login (with 2FA if enabled)", tags: ["auth"] }),
    validate("json", loginBody),
    async (c) => {
      const { email, password, totp } = c.req.valid("json");
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.email, email.toLowerCase()))
        .limit(1);
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        throw errors.unauthorized("Invalid credentials");
      }
      if (user.totpEnabled) {
        if (!totp) throw errors.unauthorized("2FA code required");
        if (!verifyTotp(user.totpSecret!, totp, user.email)) {
          throw errors.unauthorized("Invalid 2FA code");
        }
      }
      const session = await issueSession(user.id);
      return c.json({ user: { id: user.id, email: user.email, name: user.name }, ...session });
    },
  );

  app.post(
    "/refresh",
    describeRoute({ description: "Rotate refresh token, get a new access token", tags: ["auth"] }),
    validate("json", z.object({ refreshToken: z.string() })),
    async (c) => {
      const { refreshToken } = c.req.valid("json");
      const hash = sha256(refreshToken);
      const [row] = await db
        .select()
        .from(refreshTokens)
        .where(
          and(
            eq(refreshTokens.tokenHash, hash),
            isNull(refreshTokens.revokedAt),
            gt(refreshTokens.expiresAt, new Date()),
          ),
        )
        .limit(1);
      if (!row) throw errors.unauthorized("Invalid refresh token");

      // Rotate: revoke the old token, issue a new pair.
      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.id, row.id));
      const session = await issueSession(row.userId);
      return c.json(session);
    },
  );

  app.post(
    "/logout",
    describeRoute({ description: "Revoke a refresh token", tags: ["auth"] }),
    validate("json", z.object({ refreshToken: z.string() })),
    async (c) => {
      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.tokenHash, sha256(c.req.valid("json").refreshToken)));
      return c.body(null, 204);
    },
  );

  app.get(
    "/me",
    describeRoute({ description: "Current user + orgs", tags: ["auth"] }),
    requireAuth,
    async (c) => {
      const auth = c.get("auth");
      if (auth.kind !== "user") throw errors.forbidden("User token required");
      const [user] = await db
        .select({ id: users.id, email: users.email, name: users.name, totpEnabled: users.totpEnabled })
        .from(users)
        .where(eq(users.id, auth.userId))
        .limit(1);
      if (!user) throw errors.notFound("User not found");
      const memberships = await db
        .select({ orgId: orgMembers.orgId, role: orgMembers.role })
        .from(orgMembers)
        .where(eq(orgMembers.userId, auth.userId));
      return c.json({ user, orgs: memberships });
    },
  );

  // ── 2FA / TOTP ──────────────────────────────────────────
  app.post(
    "/2fa/setup",
    describeRoute({ description: "Start 2FA setup — returns QR + secret", tags: ["auth"] }),
    requireAuth,
    async (c) => {
      const auth = c.get("auth");
      if (auth.kind !== "user") throw errors.forbidden("User token required");
      const [user] = await db.select().from(users).where(eq(users.id, auth.userId)).limit(1);
      if (!user) throw errors.notFound("User not found");
      if (user.totpEnabled) throw errors.conflict("2FA already enabled");

      const secret = newTotpSecret();
      await db.update(users).set({ totpSecret: secret }).where(eq(users.id, user.id));
      const { uri, qr } = await totpProvisioning(secret, user.email);
      return c.json({ secret, uri, qr });
    },
  );

  app.post(
    "/2fa/enable",
    describeRoute({ description: "Confirm 2FA with a code, get recovery codes", tags: ["auth"] }),
    requireAuth,
    validate("json", z.object({ code: z.string().length(6) })),
    async (c) => {
      const auth = c.get("auth");
      if (auth.kind !== "user") throw errors.forbidden("User token required");
      const [user] = await db.select().from(users).where(eq(users.id, auth.userId)).limit(1);
      if (!user?.totpSecret) throw errors.badRequest("Start setup first");
      if (!verifyTotp(user.totpSecret, c.req.valid("json").code, user.email)) {
        throw errors.unauthorized("Invalid code");
      }
      const recoveryCodes = newRecoveryCodes();
      await db
        .update(users)
        .set({ totpEnabled: true, recoveryCodes })
        .where(eq(users.id, user.id));
      return c.json({ enabled: true, recoveryCodes });
    },
  );

  app.post(
    "/2fa/disable",
    describeRoute({ description: "Disable 2FA", tags: ["auth"] }),
    requireAuth,
    validate("json", z.object({ code: z.string().length(6) })),
    async (c) => {
      const auth = c.get("auth");
      if (auth.kind !== "user") throw errors.forbidden("User token required");
      const [user] = await db.select().from(users).where(eq(users.id, auth.userId)).limit(1);
      if (!user?.totpEnabled || !user.totpSecret) throw errors.badRequest("2FA not enabled");
      if (!verifyTotp(user.totpSecret, c.req.valid("json").code, user.email)) {
        throw errors.unauthorized("Invalid code");
      }
      await db
        .update(users)
        .set({ totpEnabled: false, totpSecret: null, recoveryCodes: null })
        .where(eq(users.id, user.id));
      return c.json({ enabled: false });
    },
  );

  return app;
}
