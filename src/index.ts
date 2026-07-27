import { app } from "./app.ts";
import { websocket } from "./realtime/bun-ws.ts";
import { env } from "./env.ts";
import { startWebhookDispatcher } from "./workers/webhook-dispatcher.ts";

const stopDispatcher = startWebhookDispatcher();

const server = Bun.serve({
  port: env.PORT,
  fetch: app.fetch,
  websocket,
});

console.log(
  `⚡ core-api on http://localhost:${server.port}  ·  docs /docs  ·  env ${env.NODE_ENV}`,
);
// A missing dictionary is not an error — speech still works, it just reads Malagasy
// names as French. Nothing downstream would ever say so, hence here.
if (env.ELEVENLABS_API_KEY && !(env.ELEVENLABS_DICT_ID && env.ELEVENLABS_DICT_VERSION)) {
  console.warn("⚠️  ELEVENLABS_DICT_ID/_VERSION absents — les noms malgaches seront lus à la française.");
}

// Graceful shutdown.
function shutdown(signal: string) {
  console.log(`\n${signal} received, shutting down…`);
  stopDispatcher();
  server.stop();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
