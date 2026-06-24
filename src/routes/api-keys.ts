import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { and, eq, desc } from "drizzle-orm";
import { db } from "../db/index.ts";
import { apiKeys } from "../db/schema.ts";
import type { Variables } from "../types.ts";
import { id, randomToken } from "../lib/ids.ts";
import { sha256 } from "../lib/crypto.ts";
import { errors } from "../lib/errors.ts";
import { validate } from "../lib/validate.ts";
import { requireAuth, API_KEY_PREFIX } from "../middleware/auth.ts";
import { requireOrg, requireRole } from "../middleware/org-scope.ts";

export function apiKeysRoute(): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();
  app.use("*", requireAuth, requireOrg);

  app.get(
    "/",
    describeRoute({ description: "List API keys (no secrets)", tags: ["api-keys"] }),
    async (c) => {
      const rows = await db
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          prefix: apiKeys.prefix,
          scopes: apiKeys.scopes,
          lastUsedAt: apiKeys.lastUsedAt,
          revokedAt: apiKeys.revokedAt,
          createdAt: apiKeys.createdAt,
        })
        .from(apiKeys)
        .where(eq(apiKeys.orgId, c.get("org").id))
        .orderBy(desc(apiKeys.createdAt));
      return c.json({ data: rows });
    },
  );

  app.post(
    "/",
    describeRoute({ description: "Create an API key (secret shown once)", tags: ["api-keys"] }),
    requireRole("owner", "admin"),
    validate(
      "json",
      z.object({
        name: z.string().min(1).max(120),
        scopes: z.array(z.string()).max(50).default([]),
      }),
    ),
    async (c) => {
      const { name, scopes } = c.req.valid("json");
      const secret = `${API_KEY_PREFIX}${randomToken(24)}`;
      const keyId = id("key");
      await db.insert(apiKeys).values({
        id: keyId,
        orgId: c.get("org").id,
        name,
        keyHash: sha256(secret),
        prefix: secret.slice(0, 11),
        scopes,
      });
      // `key` is returned exactly once and never stored in plaintext.
      return c.json({ id: keyId, name, scopes, key: secret }, 201);
    },
  );

  app.delete(
    "/:id",
    describeRoute({ description: "Revoke an API key", tags: ["api-keys"] }),
    requireRole("owner", "admin"),
    async (c) => {
      const res = await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiKeys.id, c.req.param("id")), eq(apiKeys.orgId, c.get("org").id)))
        .returning({ id: apiKeys.id });
      if (res.length === 0) throw errors.notFound("API key not found");
      return c.body(null, 204);
    },
  );

  return app;
}
