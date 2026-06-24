import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** Shared column helpers. IDs are prefixed nanoids (see lib/ids.ts). */
const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow();

// ── Users ────────────────────────────────────────────────
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    name: text("name"),
    // 2FA / TOTP
    totpSecret: text("totp_secret"),
    totpEnabled: boolean("totp_enabled").notNull().default(false),
    recoveryCodes: jsonb("recovery_codes").$type<string[]>(),
    createdAt,
    updatedAt,
  },
  (t) => [uniqueIndex("users_email_uq").on(sql`lower(${t.email})`)],
);

// ── Refresh tokens (hashed, rotating) ────────────────────
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [
    index("refresh_user_idx").on(t.userId),
    uniqueIndex("refresh_hash_uq").on(t.tokenHash),
  ],
);

// ── Organizations (tenants) ──────────────────────────────
export const orgs = pgTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  createdAt,
  updatedAt,
});

export const orgMembers = pgTable(
  "org_members",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"), // owner | admin | member
    createdAt,
  },
  (t) => [
    uniqueIndex("org_member_uq").on(t.orgId, t.userId),
    index("org_member_user_idx").on(t.userId),
  ],
);

// ── API keys (machine-to-machine) ────────────────────────
export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Only the hash is stored; the plaintext is shown once at creation.
    keyHash: text("key_hash").notNull(),
    prefix: text("prefix").notNull(), // first chars, shown for identification
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [
    uniqueIndex("api_key_hash_uq").on(t.keyHash),
    index("api_key_org_idx").on(t.orgId),
  ],
);

// ── Idempotency keys ─────────────────────────────────────
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: text("id").primaryKey(), // the client-supplied key, scoped by org+method+path
    orgId: text("org_id"),
    requestHash: text("request_hash").notNull(),
    statusCode: integer("status_code").notNull(),
    responseBody: jsonb("response_body"),
    createdAt,
  },
);

// ── Webhooks ─────────────────────────────────────────────
export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    secret: text("secret").notNull(),
    events: jsonb("events").$type<string[]>().notNull().default([]), // [] = all
    active: boolean("active").notNull().default(true),
    createdAt,
  },
  (t) => [index("webhook_org_idx").on(t.orgId)],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"), // pending | success | failed
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt,
  },
  (t) => [index("delivery_status_idx").on(t.status, t.nextAttemptAt)],
);

// ── Items (sample resource — copy this to add your own) ──
export const items = pgTable(
  "items",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    data: jsonb("data"),
    createdAt,
    updatedAt,
  },
  (t) => [index("items_org_idx").on(t.orgId, t.id)],
);

export type User = typeof users.$inferSelect;
export type Org = typeof orgs.$inferSelect;
export type OrgMember = typeof orgMembers.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Item = typeof items.$inferSelect;
export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;
