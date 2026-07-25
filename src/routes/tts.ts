import { Hono } from "hono";
import { ttsGet } from "../lib/tts.ts";

/**
 * Serve synthesized narration clips by content hash. The hash is derived from
 * (model, voice, text) and is unguessable in practice, so the route is public —
 * it has to be, since the browser loads these straight into an `<audio>` element
 * and a game guest holds no org scope.
 *
 * Clips live only in the replica's memory cache: a miss is a normal outcome (the
 * room moved, the cache evicted, the process restarted) and the client silently
 * falls back to text.
 */
export function ttsRoute(): Hono {
  const app = new Hono();

  app.get("/:hash", (c) => {
    const hash = c.req.param("hash");
    if (!/^[a-f0-9]{32}$/.test(hash)) return c.json({ error: { code: "bad_request", message: "invalid hash", details: null } }, 400);

    const clip = ttsGet(hash);
    if (!clip) return c.json({ error: { code: "not_found", message: "clip expired", details: null } }, 404);

    c.header("Content-Type", clip.type);
    c.header("Content-Length", String(clip.bytes.byteLength));
    c.header("Cache-Control", "public, max-age=86400, immutable"); // content-addressed
    c.header("Access-Control-Allow-Origin", "*"); // media only, no credentials
    return c.body(clip.bytes as unknown as ArrayBuffer);
  });

  return app;
}
