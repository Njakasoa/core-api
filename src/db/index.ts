import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env.ts";
import * as schema from "./schema.ts";

// Single shared connection pool. postgres.js handles pooling; tune `max` for
// your instance size. Stateless app → scale horizontally behind a balancer.
export const sql = postgres(env.DATABASE_URL, {
  max: env.NODE_ENV === "test" ? 1 : 10,
  onnotice: () => {},
});

export const db = drizzle(sql, { schema });
export type DB = typeof db;
export { schema };
