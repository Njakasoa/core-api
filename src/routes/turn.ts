import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import type { Variables } from "../types.ts";
import { requireAuth } from "../middleware/auth.ts";
import { AppError } from "../lib/errors.ts";
import { env } from "../env.ts";

/** STUN-only fallback when no TURN provider is configured. */
const STUN_ONLY = [{ urls: ["stun:stun.cloudflare.com:3478"] }];

/**
 * Mint short-lived WebRTC ICE servers for the browser game (warzone). The
 * Cloudflare TURN secrets stay server-side; the client only ever sees
 * ephemeral credentials. Requires a Bearer token (the game's guest token is
 * enough) so anonymous callers can't drain the TURN quota.
 */
export function turnRoute(): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.post(
    "/credentials",
    describeRoute({
      description: "Short-lived WebRTC ICE servers (STUN/TURN) for peer connections",
      tags: ["realtime"],
    }),
    requireAuth,
    async (c) => {
      if (!env.CF_TURN_KEY_ID || !env.CF_TURN_API_TOKEN) {
        return c.json({ iceServers: STUN_ONLY });
      }

      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.CF_TURN_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ttl: env.TURN_TTL }),
        },
      );

      if (!res.ok) {
        throw new AppError(502, "bad_gateway", "TURN provider returned an error");
      }

      const data = (await res.json()) as { iceServers: unknown };
      return c.json({ iceServers: data.iceServers });
    },
  );

  return app;
}
