import type { MiddlewareHandler } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { orgMembers } from "../db/schema.ts";
import { errors } from "../lib/errors.ts";

/**
 * Resolve the active organization for the request and authorize access.
 *  - API-key principals are bound to their key's org.
 *  - User principals pass the org via the `X-Org-Id` header; membership is
 *    verified and the member role is attached.
 * Sets c.var.org. Must run after requireAuth.
 */
export const requireOrg: MiddlewareHandler = async (c, next) => {
  const auth = c.get("auth");

  if (auth.kind === "apiKey") {
    c.set("org", { id: auth.orgId, role: "service" });
    return next();
  }

  const orgId = c.req.header("X-Org-Id");
  if (!orgId) throw errors.badRequest("Missing X-Org-Id header");

  const [member] = await db
    .select()
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, auth.userId)))
    .limit(1);

  if (!member) throw errors.forbidden("You are not a member of this org");

  c.set("org", { id: orgId, role: member.role });
  return next();
};

/** Require the caller's org role to be one of the allowed roles. */
export function requireRole(...roles: string[]): MiddlewareHandler {
  return async (c, next) => {
    const org = c.get("org");
    // Service (API key) principals bypass the human role check.
    if (org.role !== "service" && !roles.includes(org.role)) {
      throw errors.forbidden(`Requires role: ${roles.join(" or ")}`);
    }
    await next();
  };
}
