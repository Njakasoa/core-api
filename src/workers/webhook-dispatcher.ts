import { processDueDeliveries } from "../lib/webhooks.ts";

/**
 * In-process background dispatcher. Polls for due webhook deliveries and sends
 * them. For multi-instance deployments, run this as a single dedicated worker
 * (or move to a real queue) to avoid duplicate sends.
 */
let running = false;

export function startWebhookDispatcher(intervalMs = 2000): () => void {
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      // Drain in batches until nothing is due.
      while ((await processDueDeliveries()) >= 20) {
        /* keep going */
      }
    } catch (err) {
      console.error("[webhooks] dispatch error", err);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
