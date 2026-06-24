import { z } from "zod";

/**
 * Validated, typed environment. Import `env` everywhere instead of reading
 * `process.env` directly — a missing/invalid var fails fast at boot.
 * Bun auto-loads `.env`, so no dotenv dependency is needed.
 */
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  CORS_ORIGINS: z.string().default("*"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must be at least 32 characters"),
  ACCESS_TTL: z.coerce.number().int().positive().default(900),
  REFRESH_TTL: z.coerce.number().int().positive().default(2_592_000),

  RATE_LIMIT_WINDOW: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),

  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

export const isProd = env.NODE_ENV === "production";
export const corsOrigins =
  env.CORS_ORIGINS === "*"
    ? "*"
    : env.CORS_ORIGINS.split(",").map((s) => s.trim());
