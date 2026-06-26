import { createBunWebSocket } from "hono/bun";

/**
 * Bun can register exactly one WebSocket handler with `Bun.serve({ websocket })`.
 * Every realtime route (the generic relay `/rt`, the quiz game `/quiz/rt`, …)
 * must share this single instance — so it lives here and is imported everywhere.
 */
export const { upgradeWebSocket, websocket } = createBunWebSocket();
