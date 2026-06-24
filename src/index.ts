import { app } from "./app.ts";
import { websocket } from "./realtime/ws.ts";
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

// Graceful shutdown.
function shutdown(signal: string) {
  console.log(`\n${signal} received, shutting down…`);
  stopDispatcher();
  server.stop();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
