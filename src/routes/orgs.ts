import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { orgs, orgMembers, users } from "../db/schema.ts";
import type { Variables } from "../types.ts";
import { id } from "../lib/ids.ts";
import { errors } from "../lib/errors.ts";
import { validate } from "../lib/validate.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireOrg, requireRole } from "../middleware/org-scope.ts";

export function orgsRoute(): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  // Create a new org (any authenticated user becomes its owner).
  app.post(
    "/",
    describeRoute({ description: "Create an organization", tags: ["orgs"] }),
    requireAuth,
    validate("json", z.object({ name: z.string().min(1).max(120) })),
    async (c) => {
      const auth = c.get("auth");
      if (auth.kind !== "user") throw errors.forbidden("User token required");
      const orgId = id("org");
      const slug = c.req.valid("json").name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 32);
      await db.transaction(async (tx) => {
        await tx.insert(orgs).values({ id: orgId, name: c.req.valid("json").name, slug });
        await tx.insert(orgMembers).values({ id: id("mem"), orgId, userId: auth.userId, role: "owner" });
      });
      return c.json({ id: orgId, name: c.req.valid("json").name, slug }, 201);
    },
  );

  // Everything below is scoped to the active org (X-Org-Id).
  app.use("/current/*", requireAuth, requireOrg);

  app.get(
    "/current",
    describeRoute({ description: "Get the active org", tags: ["orgs"] }),
    async (c) => {
      const [org] = await db.select().from(orgs).where(eq(orgs.id, c.get("org").id)).limit(1);
      return c.json({ ...org, role: c.get("org").role });
    },
  );

  app.get(
    "/current/members",
    describeRoute({ description: "List members of the active org", tags: ["orgs"] }),
    async (c) => {
      const rows = await db
        .select({
          userId: orgMembers.userId,
          role: orgMembers.role,
          email: users.email,
          name: users.name,
        })
        .from(orgMembers)
        .innerJoin(users, eq(users.id, orgMembers.userId))
        .where(eq(orgMembers.orgId, c.get("org").id));
      return c.json({ data: rows });
    },
  );

  // Add a member by email (owner/admin only).
  app.post(
    "/current/members",
    describeRoute({ description: "Add a member by email", tags: ["orgs"] }),
    requireRole("owner", "admin"),
    validate(
      "json",
      z.object({
        email: z.string().email(),
        role: z.enum(["admin", "member"]).default("member"),
      }),
    ),
    async (c) => {
      const { email, role } = c.req.valid("json");
      const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email.toLowerCase())).limit(1);
      if (!user) throw errors.notFound("No user with that email");
      const orgId = c.get("org").id;
      const [existing] = await db
        .select({ id: orgMembers.id })
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, user.id)))
        .limit(1);
      if (existing) throw errors.conflict("Already a member");
      await db.insert(orgMembers).values({ id: id("mem"), orgId, userId: user.id, role });
      return c.json({ userId: user.id, role }, 201);
    },
  );

  app.delete(
    "/current/members/:userId",
    describeRoute({ description: "Remove a member", tags: ["orgs"] }),
    requireRole("owner", "admin"),
    async (c) => {
      const res = await db
        .delete(orgMembers)
        .where(and(eq(orgMembers.orgId, c.get("org").id), eq(orgMembers.userId, c.req.param("userId"))))
        .returning({ id: orgMembers.id });
      if (res.length === 0) throw errors.notFound("Member not found");
      return c.body(null, 204);
    },
  );

  return app;
}
