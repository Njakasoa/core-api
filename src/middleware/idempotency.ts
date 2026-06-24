import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { idempotencyKeys } from "../db/schema.ts";
import { sha256 } from "../lib/crypto.ts";
import { errors } from "../lib/errors.ts";

/**
 * Idempotent writes. When a client sends `Idempotency-Key` on a POST, the
 * first response is persisted and replayed for any retry with the same key.
 * Reusing a key with a different request body is a 409.
 * Apply to POST routes that create resources. Runs after requireOrg.
 */
export const idempotency: MiddlewareHandler = async (c, next) => {
  const key = c.req.header("Idempotency-Key");
  if (!key) return next();

  const org = c.get("org");
  const storeId = `${org?.id ?? "_"}:${key}`;
  const body = await c.req.raw.clone().text();
  const requestHash = sha256(`${c.req.method} ${c.req.path} ${body}`);

  const [existing] = await db
    .select()
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.id, storeId))
    .limit(1);

  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw errors.conflict("Idempotency-Key reused with a different request");
    }
    c.header("Idempotency-Replayed", "true");
    return c.json(existing.responseBody as object, existing.statusCode as 200);
  }

  await next();

  // Persist successful (2xx) responses for replay.
  if (c.res.status >= 200 && c.res.status < 300) {
    const resBody = await c.res.clone().json().catch(() => null);
    await db
      .insert(idempotencyKeys)
      .values({
        id: storeId,
        orgId: org?.id ?? null,
        requestHash,
        statusCode: c.res.status,
        responseBody: resBody,
      })
      .onConflictDoNothing();
  }
};
