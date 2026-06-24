import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { sql as raw } from "drizzle-orm";
import { db } from "../db/index.ts";

export function healthRoute(): Hono {
  const app = new Hono();

  // Liveness — process is up.
  app.get(
    "/healthz",
    describeRoute({
      description: "Liveness probe",
      tags: ["meta"],
      responses: { 200: { description: "alive" } },
    }),
    (c) => c.json({ status: "ok" }),
  );

  // Readiness — dependencies (DB) reachable.
  app.get(
    "/readyz",
    describeRoute({
      description: "Readiness probe (checks the database)",
      tags: ["meta"],
      responses: {
        200: { description: "ready" },
        503: { description: "not ready" },
      },
    }),
    async (c) => {
      try {
        await db.execute(raw`select 1`);
        return c.json({ status: "ready", db: "up" });
      } catch {
        return c.json({ status: "not_ready", db: "down" }, 503);
      }
    },
  );

  return app;
}
