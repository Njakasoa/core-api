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
  /**
   * How many proxies append to `x-forwarded-for` in front of this process.
   * The rate limiter reads that many hops from the RIGHT, because each proxy
   * appends the peer it saw and only the last entry is one the caller cannot
   * forge — reading the first hop let anyone mint a fresh bucket per request.
   * 1 for the Caddy in deploy/Caddyfile.example; 2 if Cloudflare fronts it too.
   * Raising this beyond the real chain length trusts a hop the client controls.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().positive().default(1),

  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  // Cloudflare Realtime TURN — optional. When both are set, /v1/turn/credentials
  // mints short-lived ICE servers from Cloudflare's global TURN network; when
  // absent the endpoint falls back to STUN-only.
  CF_TURN_KEY_ID: z.string().optional(),
  CF_TURN_API_TOKEN: z.string().optional(),
  TURN_TTL: z.coerce.number().int().positive().default(86_400),

  // AI gateway (ai.njakasoa.xyz) — optional. Server-to-server generative content
  // (e.g. Angano's story narrator). When AI_API_TOKEN is unset the feature is off
  // and games fall back to their built-in defaults.
  AI_BASE_URL: z.string().default("https://ai.njakasoa.xyz"),
  AI_API_TOKEN: z.string().optional(),
  AI_PROVIDER: z.enum(["claude", "codex"]).optional(),
  AI_MODEL: z.string().min(1).optional(),
  AI_REASONING_EFFORT: z.string().min(1).optional(),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),

  // ElevenLabs text-to-speech — optional. Powers Angano's spoken narration. The
  // feature only turns on when BOTH the key and a narrator voice are set; with
  // either missing the games stay text-only (never a hard dependency).
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_BASE_URL: z.string().default("https://api.elevenlabs.io"),
  // Measured on a typical narration line: flash_v2_5 544ms, multilingual_v2 1362ms,
  // v3 3572ms. The warm-up runs ~10 lines 4-at-a-time inside a 12s budget, so
  // multilingual_v2 fits comfortably and reads far better than flash. Match this to
  // whatever the front's static voice lines were generated with, or the narrator
  // subtly changes character between a role reveal and the story.
  ELEVENLABS_MODEL: z.string().min(1).default("eleven_multilingual_v2"),
  /** Grandpa Storyteller Oxley — the teller of the recorded legend, so the runtime
   *  narration and the pack speak with one voice. */
  ELEVENLABS_VOICE_NARRATOR: z.string().default("0dPqNXnhg2bmxQv1WKDp"),
  /**
   * Pronunciation dictionary applied to every synthesis — Malagasy role names, common
   * words and place names, respelled for a French voice. Held at ElevenLabs and
   * referenced by id; the rules themselves are versioned in the front repo
   * (`scripts/pronunciation-rules.ts`), which is what creates and updates it.
   *
   * Optional, and its absence is a degradation rather than a failure: names are then
   * read as French. `index.ts` says so at startup, because nothing downstream would.
   */
  ELEVENLABS_DICT_ID: z.string().optional(),
  ELEVENLABS_DICT_VERSION: z.string().optional(),
  // Voice settings, all optional — omitted ones keep the voice's own defaults.
  // stability: low = expressive, high = flat. style: acting exaggeration, unstable
  // past ~0.6. speed: below 1 is slower and graver. Audition them with the front's
  // `bun scripts/audition-voice.ts` before pinning values here.
  ELEVENLABS_STABILITY: z.coerce.number().min(0).max(1).optional(),
  ELEVENLABS_SIMILARITY: z.coerce.number().min(0).max(1).optional(),
  ELEVENLABS_STYLE: z.coerce.number().min(0).max(1).optional(),
  ELEVENLABS_SPEED: z.coerce.number().min(0.7).max(1.2).optional(),
  TTS_TIMEOUT_MS: z.coerce.number().int().positive().default(12_000),
  // In-memory clip cache ceiling. Rooms already live in process memory, so a
  // per-replica cache adds no new scaling constraint (see ARCHITECTURE.md).
  TTS_CACHE_MB: z.coerce.number().int().positive().default(64),
  // Hard ceiling on synthesized characters per Angano room — caps the bill.
  ANGANO_TTS_CHAR_BUDGET: z.coerce.number().int().positive().default(8_000),
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
