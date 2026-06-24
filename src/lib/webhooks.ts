import { and, eq, lte, or, isNull } from "drizzle-orm";
import { db } from "../db/index.ts";
import { webhookDeliveries, webhookEndpoints } from "../db/schema.ts";
import { hmacSign } from "./crypto.ts";
import { id } from "./ids.ts";
import { env } from "../env.ts";

/**
 * Enqueue an event for delivery to every active endpoint in an org that
 * subscribes to it (empty `events` array = all events). Returns immediately;
 * the background dispatcher (workers/webhook-dispatcher.ts) does the sending.
 */
export async function emitEvent(
  orgId: string,
  event: string,
  payload: unknown,
): Promise<void> {
  const endpoints = await db
    .select()
    .from(webhookEndpoints)
    .where(
      and(eq(webhookEndpoints.orgId, orgId), eq(webhookEndpoints.active, true)),
    );

  const targets = endpoints.filter(
    (e) => e.events.length === 0 || e.events.includes(event),
  );
  if (targets.length === 0) return;

  await db.insert(webhookDeliveries).values(
    targets.map((e) => ({
      id: id("whd"),
      endpointId: e.id,
      event,
      payload: payload as object,
      status: "pending" as const,
      attempts: 0,
      nextAttemptAt: new Date(),
    })),
  );
}

/** Build the signature header value for a delivery body. */
export function signBody(body: string, secret: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const sig = hmacSign(`${ts}.${body}`, secret);
  return `t=${ts},v1=${sig}`;
}

/**
 * Process one batch of due deliveries. Returns the number processed.
 * Called on an interval by the dispatcher; safe to call concurrently-ish
 * because each delivery row is advanced atomically.
 */
export async function processDueDeliveries(limit = 20): Promise<number> {
  const now = new Date();
  const due = await db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.status, "pending"),
        or(
          isNull(webhookDeliveries.nextAttemptAt),
          lte(webhookDeliveries.nextAttemptAt, now),
        ),
      ),
    )
    .limit(limit);

  for (const d of due) {
    const [endpoint] = await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, d.endpointId))
      .limit(1);
    if (!endpoint) {
      await db
        .update(webhookDeliveries)
        .set({ status: "failed", lastError: "endpoint deleted" })
        .where(eq(webhookDeliveries.id, d.id));
      continue;
    }

    const body = JSON.stringify({
      id: d.id,
      event: d.event,
      data: d.payload,
    });
    const attempts = d.attempts + 1;

    try {
      const res = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "webhook-signature": signBody(body, endpoint.secret),
          "webhook-id": d.id,
          "webhook-event": d.event,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await db
        .update(webhookDeliveries)
        .set({ status: "success", attempts })
        .where(eq(webhookDeliveries.id, d.id));
    } catch (err) {
      const failed = attempts >= env.WEBHOOK_MAX_ATTEMPTS;
      // Exponential backoff: 2^attempts seconds.
      const next = new Date(Date.now() + 2 ** attempts * 1000);
      await db
        .update(webhookDeliveries)
        .set({
          status: failed ? "failed" : "pending",
          attempts,
          nextAttemptAt: failed ? null : next,
          lastError: err instanceof Error ? err.message : "unknown",
        })
        .where(eq(webhookDeliveries.id, d.id));
    }
  }
  return due.length;
}
