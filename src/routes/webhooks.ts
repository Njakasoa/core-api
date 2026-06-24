import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { and, eq, desc } from "drizzle-orm";
import { db } from "../db/index.ts";
import { webhookEndpoints, webhookDeliveries } from "../db/schema.ts";
import type { Variables } from "../types.ts";
import { id, randomToken } from "../lib/ids.ts";
import { errors } from "../lib/errors.ts";
import { validate } from "../lib/validate.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireOrg, requireRole } from "../middleware/org-scope.ts";

export function webhooksRoute(): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();
  app.use("*", requireAuth, requireOrg);

  app.get(
    "/",
    describeRoute({ description: "List webhook endpoints", tags: ["webhooks"] }),
    async (c) => {
      const rows = await db
        .select({
          id: webhookEndpoints.id,
          url: webhookEndpoints.url,
          events: webhookEndpoints.events,
          active: webhookEndpoints.active,
          createdAt: webhookEndpoints.createdAt,
        })
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.orgId, c.get("org").id));
      return c.json({ data: rows });
    },
  );

  app.post(
    "/",
    describeRoute({ description: "Register a webhook endpoint (secret shown once)", tags: ["webhooks"] }),
    requireRole("owner", "admin"),
    validate(
      "json",
      z.object({
        url: z.string().url(),
        events: z.array(z.string()).max(50).default([]),
      }),
    ),
    async (c) => {
      const { url, events } = c.req.valid("json");
      const secret = `whsec_${randomToken(24)}`;
      const epId = id("whe");
      await db.insert(webhookEndpoints).values({
        id: epId,
        orgId: c.get("org").id,
        url,
        secret,
        events,
      });
      return c.json({ id: epId, url, events, secret }, 201);
    },
  );

  app.delete(
    "/:id",
    describeRoute({ description: "Delete a webhook endpoint", tags: ["webhooks"] }),
    requireRole("owner", "admin"),
    async (c) => {
      const res = await db
        .delete(webhookEndpoints)
        .where(and(eq(webhookEndpoints.id, c.req.param("id")), eq(webhookEndpoints.orgId, c.get("org").id)))
        .returning({ id: webhookEndpoints.id });
      if (res.length === 0) throw errors.notFound("Endpoint not found");
      return c.body(null, 204);
    },
  );

  app.get(
    "/:id/deliveries",
    describeRoute({ description: "Recent delivery attempts for an endpoint", tags: ["webhooks"] }),
    async (c) => {
      const [ep] = await db
        .select({ id: webhookEndpoints.id })
        .from(webhookEndpoints)
        .where(and(eq(webhookEndpoints.id, c.req.param("id")), eq(webhookEndpoints.orgId, c.get("org").id)))
        .limit(1);
      if (!ep) throw errors.notFound("Endpoint not found");
      const rows = await db
        .select({
          id: webhookDeliveries.id,
          event: webhookDeliveries.event,
          status: webhookDeliveries.status,
          attempts: webhookDeliveries.attempts,
          lastError: webhookDeliveries.lastError,
          createdAt: webhookDeliveries.createdAt,
        })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.endpointId, ep.id))
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(50);
      return c.json({ data: rows });
    },
  );

  return app;
}
