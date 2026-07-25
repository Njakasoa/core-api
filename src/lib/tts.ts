import { createHash } from "node:crypto";
import { env } from "../env.ts";

/**
 * Server-side gateway to ElevenLabs text-to-speech. Games call this to voice their
 * narration; the API key never leaves the server. Synthesized clips are held in a
 * content-addressed in-memory cache and served back by `/v1/tts/:hash` — rooms
 * already live in process memory, so a per-replica cache adds no new scaling
 * constraint (see ARCHITECTURE.md).
 *
 * Every failure path (no key, timeout, upstream error, budget exhausted) returns
 * `null` so callers degrade to text-only. The game must never block on speech.
 */

export interface TtsClip {
  hash: string;
  bytes: Uint8Array;
  type: string;
}

/** Insertion-ordered LRU: re-inserting on read moves an entry to the tail. */
const cache = new Map<string, TtsClip>();
let cacheBytes = 0;

/**
 * Test seam. `bun test` auto-loads `.env`, so without this a test run would call
 * the real ElevenLabs account — billing it, and making the suite slow and flaky.
 * Speech is therefore off under NODE_ENV=test until a test opts in explicitly.
 */
let enabledInTests = false;
export function ttsSetEnabledForTests(on: boolean): void {
  enabledInTests = on;
}

export function ttsEnabled(): boolean {
  if (env.NODE_ENV === "test" && !enabledInTests) return false;
  return !!(env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_NARRATOR);
}

/**
 * Content address of a clip — same text + voice + model + tuning ⇒ same hash ⇒
 * free replay. The tuning belongs in the key: re-tuning stability must not keep
 * serving the previous rendering.
 */
export function ttsHash(text: string, voiceId: string, modelId: string, settings?: unknown): string {
  const tuning = settings ? JSON.stringify(settings) : "";
  return createHash("sha256").update(`${modelId}\u0000${voiceId}\u0000${tuning}\u0000${text}`).digest("hex").slice(0, 32);
}

/**
 * Voice settings, or undefined to keep the voice's own defaults. Low stability is
 * expressive, high is flat; `style` exaggerates the acting and gets unstable past
 * ~0.6; `speed` below 1 is slower and graver. Audition values with the front's
 * `bun scripts/audition-voice.ts` before pinning them here.
 */
function voiceSettings(): Record<string, number> | undefined {
  const settings: Record<string, number> = {};
  if (env.ELEVENLABS_STABILITY !== undefined) settings.stability = env.ELEVENLABS_STABILITY;
  if (env.ELEVENLABS_SIMILARITY !== undefined) settings.similarity_boost = env.ELEVENLABS_SIMILARITY;
  if (env.ELEVENLABS_STYLE !== undefined) settings.style = env.ELEVENLABS_STYLE;
  if (env.ELEVENLABS_SPEED !== undefined) settings.speed = env.ELEVENLABS_SPEED;
  return Object.keys(settings).length ? settings : undefined;
}

export function ttsGet(hash: string): TtsClip | undefined {
  const clip = cache.get(hash);
  if (!clip) return undefined;
  cache.delete(hash); // touch → most-recently-used
  cache.set(hash, clip);
  return clip;
}

export function ttsCacheStats(): { clips: number; bytes: number } {
  return { clips: cache.size, bytes: cacheBytes };
}

/** Test seam — drops every cached clip. */
export function ttsCacheClear(): void {
  cache.clear();
  cacheBytes = 0;
}

function cacheStore(clip: TtsClip): void {
  if (cache.has(clip.hash)) return;
  cache.set(clip.hash, clip);
  cacheBytes += clip.bytes.byteLength;
  const cap = env.TTS_CACHE_MB * 1024 * 1024;
  while (cacheBytes > cap && cache.size > 1) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const evicted = cache.get(oldest.value);
    cache.delete(oldest.value);
    if (evicted) cacheBytes -= evicted.bytes.byteLength;
  }
}

/**
 * Synthesize `text` and return the cached clip. A cache hit costs nothing and never
 * touches the network — callers can therefore re-request the same line freely.
 */
export async function ttsSynthesize(opts: {
  text: string;
  voiceId?: string;
  modelId?: string;
  timeoutMs?: number;
}): Promise<TtsClip | null> {
  if (!ttsEnabled()) return null;
  const text = opts.text.trim();
  if (!text) return null;

  const voiceId = opts.voiceId || env.ELEVENLABS_VOICE_NARRATOR!;
  const modelId = opts.modelId || env.ELEVENLABS_MODEL;
  const settings = voiceSettings();
  const hash = ttsHash(text, voiceId, modelId, settings);

  const hit = ttsGet(hash);
  if (hit) return hit;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? env.TTS_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${env.ELEVENLABS_BASE_URL}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": env.ELEVENLABS_API_KEY!,
          "content-type": "application/json",
          accept: "audio/mpeg",
        },
        body: JSON.stringify({ text, model_id: modelId, ...(settings ? { voice_settings: settings } : {}) }),
        signal: ctrl.signal,
      },
    );
    if (!res.ok) {
      console.warn(`[tts] upstream ${res.status} for ${text.length} chars`);
      return null;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.byteLength) return null;
    const clip: TtsClip = { hash, bytes, type: res.headers.get("content-type") || "audio/mpeg" };
    cacheStore(clip);
    return clip;
  } catch {
    return null; // timeout / network — caller falls back to text
  } finally {
    clearTimeout(timer);
  }
}
