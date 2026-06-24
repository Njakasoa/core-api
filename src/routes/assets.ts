import { Hono } from "hono";

/**
 * Serve the brand icons (shared with law.njakasoa.xyz) so the /docs tab and the
 * domain root show the njakasoa mark. Files live in src/assets and are read
 * once, cached in memory.
 */
const dir = import.meta.dir + "/../assets";
const icons: Record<string, { path: string; type: string }> = {
  "/favicon.ico": { path: `${dir}/favicon.ico`, type: "image/x-icon" },
  "/favicon.png": { path: `${dir}/favicon.png`, type: "image/png" },
  "/apple-touch-icon.png": {
    path: `${dir}/apple-touch-icon.png`,
    type: "image/png",
  },
};

export function assetsRoute(): Hono {
  const app = new Hono();
  for (const [route, { path, type }] of Object.entries(icons)) {
    const bytes = Bun.file(path).arrayBuffer();
    app.get(route, async (c) => {
      c.header("Content-Type", type);
      c.header("Cache-Control", "public, max-age=86400");
      return c.body(await bytes);
    });
  }
  return app;
}
