import type { MiddlewareHandler } from "hono";

/**
 * Lets a browser on another origin actually RENDER our media.
 *
 * `secureHeaders()` sets `Cross-Origin-Resource-Policy: same-origin` on every
 * response, and that is the right default: it stops another site from pulling
 * our bytes into its own pages. But it also stops OUR front from doing it, and
 * it does so in a way that is easy to misdiagnose — the route returns 200 with
 * `Content-Type: image/jpeg` and the correct body, and the tile stays blank.
 * `Access-Control-Allow-Origin: *` does not help: CORP is a separate gate, and
 * it governs exactly the no-cors subresource loads an `<img src>` performs.
 *
 * Only two paths are relaxed, and both are already public by design:
 *   /v1/objets/   every stored file, whatever the feature — authorized by the
 *                 guard vote in lib/stockage/objets.ts before a byte is written
 *   /v1/tts/      addressed by an unguessable hash, like the above
 *
 * The first was `/v1/bibliotheque/images/` while the store belonged to one
 * feature. Now that any feature can put files there, listing them one by one
 * would mean every new gallery ships blank tiles until someone remembers this
 * file — a bug that looks like a 200 with the right bytes.
 *
 * WHY IT IS REGISTERED BEFORE `secureHeaders()` AND NOT AFTER
 * `secureHeaders()` writes its headers AFTER `await next()`, so anything the
 * handler sets is overwritten by it. Middleware unwind in reverse registration
 * order, so registering this one EARLIER is what makes it run LATER — and
 * therefore win. Setting the header in the route handler does not work, and
 * that is the shape of the bug this file exists to prevent from coming back.
 */
const PUBLICS = ["/v1/objets/", "/v1/tts/"];

export const mediaCorp: MiddlewareHandler = async (c, next) => {
  await next();
  if (PUBLICS.some((p) => c.req.path.startsWith(p))) {
    c.res.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  }
};
