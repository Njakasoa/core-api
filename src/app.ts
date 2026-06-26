import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { requestId } from "hono/request-id";
import { bodyLimit } from "hono/body-limit";
import { openAPISpecs } from "hono-openapi";
import { apiReference } from "@scalar/hono-api-reference";

import type { Variables } from "./types.ts";
import { corsOrigins } from "./env.ts";
import { logger } from "./middleware/logger.ts";
import { rateLimit } from "./middleware/rate-limit.ts";
import { onError, notFound } from "./middleware/error-handler.ts";

import { healthRoute } from "./routes/health.ts";
import { authRoute } from "./routes/auth.ts";
import { orgsRoute } from "./routes/orgs.ts";
import { apiKeysRoute } from "./routes/api-keys.ts";
import { itemsRoute } from "./routes/items.ts";
import { webhooksRoute } from "./routes/webhooks.ts";
import { assetsRoute } from "./routes/assets.ts";
import { turnRoute } from "./routes/turn.ts";
import { realtimeRoute } from "./realtime/ws.ts";
import { quizRoute } from "./games/quiz/ws.ts";
import { anganoRoute } from "./games/angano/ws.ts";

export function createApp() {
  const app = new Hono<{ Variables: Variables }>();

  // ── Global middleware ──────────────────────────────────
  app.use("*", requestId());
  app.use("*", logger);
  app.use("*", secureHeaders());
  app.use("*", cors({ origin: corsOrigins, maxAge: 86400 }));
  app.use("*", bodyLimit({ maxSize: 1024 * 1024 }));
  app.use("/v1/*", rateLimit);

  app.onError(onError);
  app.notFound(notFound);

  // ── Meta ───────────────────────────────────────────────
  app.route("/", assetsRoute()); // /favicon.ico, etc. (njakasoa brand)
  app.route("/", healthRoute());
  app.route("/", realtimeRoute()); // GET /rt (WebSocket upgrade)
  app.route("/", quizRoute());     // GET /quiz/rt (Quiz Run game gateway)
  app.route("/", anganoRoute());   // GET /angano/rt (Angano werewolf gateway)
  app.get("/", (c) =>
    c.json({
      name: "core-api",
      version: "0.1.0",
      docs: "/docs",
      openapi: "/openapi.json",
      health: "/healthz",
    }),
  );

  // ── API v1 ─────────────────────────────────────────────
  app.route("/v1/auth", authRoute());
  app.route("/v1/orgs", orgsRoute());
  app.route("/v1/keys", apiKeysRoute());
  app.route("/v1/items", itemsRoute());
  app.route("/v1/webhooks", webhooksRoute());
  app.route("/v1/turn", turnRoute());

  // ── OpenAPI + docs (registered last so it sees every route) ──
  app.get(
    "/openapi.json",
    openAPISpecs(app, {
      documentation: {
        info: {
          title: "core-api",
          version: "0.1.0",
          description:
            "A tiny, hyperscalable API starter. Auth (JWT + API keys), multi-tenant orgs, realtime rooms, webhooks, idempotency.",
        },
        servers: [{ url: "/", description: "current host" }],
        components: {
          securitySchemes: {
            bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
          },
        },
      },
    }),
  );
  // Scalar reads the spec source from `spec.url` (see @scalar/core
  // html-rendering); a top-level `url` is ignored, which renders a blank page.
  app.get(
    "/docs",
    apiReference({
      spec: { url: "/openapi.json" },
      pageTitle: "core-api docs",
      favicon: "/favicon.png",
    }),
  );

  return app;
}

export const app = createApp();
export type App = typeof app;
