import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { and, eq, gt, asc } from "drizzle-orm";
import { db } from "../db/index.ts";
import { items } from "../db/schema.ts";
import type { Variables } from "../types.ts";
import { id } from "../lib/ids.ts";
import { errors } from "../lib/errors.ts";
import { validate } from "../lib/validate.ts";
import { pageQuery, paginate, decodeCursor } from "../lib/pagination.ts";
import { requireAuth, requireScope } from "../middleware/auth.ts";
import { requireOrg } from "../middleware/org-scope.ts";
import { idempotency } from "../middleware/idempotency.ts";
import { emitEvent } from "../lib/webhooks.ts";

/**
 * Sample resource. Copy this file to add any API of your own: it's already
 * authenticated, org-scoped, paginated, idempotent on create, and emits
 * webhook events. Swap `items` for your table and you're done.
 */
export function itemsRoute(): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();
  app.use("*", requireAuth, requireOrg);

  app.get(
    "/",
    describeRoute({ description: "List items (cursor paginated)", tags: ["items"] }),
    requireScope("items:read"),
    validate("query", pageQuery),
    async (c) => {
      const { limit, cursor } = c.req.valid("query");
      const after = decodeCursor(cursor);
      const rows = await db
        .select()
        .from(items)
        .where(
          and(
            eq(items.orgId, c.get("org").id),
            after ? gt(items.id, after) : undefined,
          ),
        )
        .orderBy(asc(items.id))
        .limit(limit + 1);
      return c.json(paginate(rows, limit));
    },
  );

  app.post(
    "/",
    describeRoute({ description: "Create an item", tags: ["items"] }),
    requireScope("items:write"),
    idempotency,
    validate(
      "json",
      z.object({
        name: z.string().min(1).max(200),
        data: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid("json");
      const orgId = c.get("org").id;
      const itemId = id("item");
      const [row] = await db
        .insert(items)
        .values({ id: itemId, orgId, name: body.name, data: body.data ?? null })
        .returning();
      await emitEvent(orgId, "item.created", row);
      return c.json(row, 201);
    },
  );

  app.get(
    "/:id",
    describeRoute({ description: "Get an item", tags: ["items"] }),
    requireScope("items:read"),
    async (c) => {
      const [row] = await db
        .select()
        .from(items)
        .where(and(eq(items.id, c.req.param("id")), eq(items.orgId, c.get("org").id)))
        .limit(1);
      if (!row) throw errors.notFound("Item not found");
      return c.json(row);
    },
  );

  app.patch(
    "/:id",
    describeRoute({ description: "Update an item", tags: ["items"] }),
    requireScope("items:write"),
    validate(
      "json",
      z.object({
        name: z.string().min(1).max(200).optional(),
        data: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid("json");
      const [row] = await db
        .update(items)
        .set({ ...body, updatedAt: new Date() })
        .where(and(eq(items.id, c.req.param("id")), eq(items.orgId, c.get("org").id)))
        .returning();
      if (!row) throw errors.notFound("Item not found");
      await emitEvent(c.get("org").id, "item.updated", row);
      return c.json(row);
    },
  );

  app.delete(
    "/:id",
    describeRoute({ description: "Delete an item", tags: ["items"] }),
    requireScope("items:write"),
    async (c) => {
      const res = await db
        .delete(items)
        .where(and(eq(items.id, c.req.param("id")), eq(items.orgId, c.get("org").id)))
        .returning({ id: items.id });
      if (res.length === 0) throw errors.notFound("Item not found");
      await emitEvent(c.get("org").id, "item.deleted", { id: c.req.param("id") });
      return c.body(null, 204);
    },
  );

  return app;
}
