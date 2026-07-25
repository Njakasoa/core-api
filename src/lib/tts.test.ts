import { afterEach, describe, expect, it } from "bun:test";
import { env } from "../env.ts";
import { ttsCacheClear, ttsCacheStats, ttsEnabled, ttsGet, ttsHash, ttsSetEnabledForTests, ttsSynthesize } from "./tts.ts";

const realFetch = globalThis.fetch;

/** Run `fn` with the feature enabled and a stubbed upstream. */
async function withUpstream(
  respond: (req: Request) => Response | Promise<Response>,
  fn: () => Promise<void>,
): Promise<void> {
  const key = env.ELEVENLABS_API_KEY;
  const voice = env.ELEVENLABS_VOICE_NARRATOR;
  (env as { ELEVENLABS_API_KEY?: string }).ELEVENLABS_API_KEY = "test-key";
  (env as { ELEVENLABS_VOICE_NARRATOR?: string }).ELEVENLABS_VOICE_NARRATOR = "test-voice";
  ttsSetEnabledForTests(true);
  globalThis.fetch = ((input: Request | string | URL, init?: RequestInit) =>
    Promise.resolve(respond(new Request(input as never, init)))) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    ttsSetEnabledForTests(false);
    (env as { ELEVENLABS_API_KEY?: string }).ELEVENLABS_API_KEY = key;
    (env as { ELEVENLABS_VOICE_NARRATOR?: string }).ELEVENLABS_VOICE_NARRATOR = voice;
  }
}

const mp3 = (n = 32) => new Response(new Uint8Array(n), { headers: { "content-type": "audio/mpeg" } });

afterEach(() => ttsCacheClear());

describe("lib/tts", () => {
  it("is off under NODE_ENV=test so a suite never bills the real account", () => {
    expect(env.NODE_ENV).toBe("test");
    expect(ttsEnabled()).toBe(false); // even though .env may carry a real key
  });

  it("is disabled unless both key and narrator voice are set", async () => {
    const key = env.ELEVENLABS_API_KEY;
    ttsSetEnabledForTests(true);
    (env as { ELEVENLABS_API_KEY?: string }).ELEVENLABS_API_KEY = undefined;
    expect(ttsEnabled()).toBe(false);
    expect(await ttsSynthesize({ text: "bonjour" })).toBeNull();
    (env as { ELEVENLABS_API_KEY?: string }).ELEVENLABS_API_KEY = key;
    ttsSetEnabledForTests(false);
  });

  it("hashes by model + voice + text", () => {
    expect(ttsHash("a", "v", "m")).toBe(ttsHash("a", "v", "m"));
    expect(ttsHash("a", "v", "m")).not.toBe(ttsHash("b", "v", "m"));
    expect(ttsHash("a", "v", "m")).not.toBe(ttsHash("a", "w", "m"));
    expect(ttsHash("a", "v", "m")).toMatch(/^[a-f0-9]{32}$/);
  });

  it("synthesizes, caches, and replays without a second upstream call", async () => {
    let calls = 0;
    await withUpstream(
      () => { calls++; return mp3(64); },
      async () => {
        const first = await ttsSynthesize({ text: "La nuit tombe." });
        expect(first?.bytes.byteLength).toBe(64);
        expect(calls).toBe(1);

        const second = await ttsSynthesize({ text: "La nuit tombe." });
        expect(second?.hash).toBe(first!.hash);
        expect(calls).toBe(1); // served from cache
        expect(ttsGet(first!.hash)?.bytes.byteLength).toBe(64);
      },
    );
  });

  it("returns null on an upstream error and caches nothing", async () => {
    await withUpstream(
      () => new Response("nope", { status: 401 }),
      async () => {
        expect(await ttsSynthesize({ text: "échec" })).toBeNull();
        expect(ttsCacheStats().clips).toBe(0);
      },
    );
  });

  it("returns null on an empty body", async () => {
    await withUpstream(
      () => mp3(0),
      async () => expect(await ttsSynthesize({ text: "vide" })).toBeNull(),
    );
  });

  it("returns null rather than throwing when the network fails", async () => {
    await withUpstream(
      () => { throw new Error("ECONNRESET"); },
      async () => expect(await ttsSynthesize({ text: "coupure" })).toBeNull(),
    );
  });

  it("ignores blank text without calling upstream", async () => {
    let calls = 0;
    await withUpstream(
      () => { calls++; return mp3(); },
      async () => {
        expect(await ttsSynthesize({ text: "   " })).toBeNull();
        expect(calls).toBe(0);
      },
    );
  });

  it("evicts the least-recently-used clip once over the cache ceiling", async () => {
    const cap = env.TTS_CACHE_MB;
    (env as { TTS_CACHE_MB: number }).TTS_CACHE_MB = 1;
    const half = 600 * 1024; // two of these overflow a 1 MB ceiling
    await withUpstream(
      () => mp3(half),
      async () => {
        const a = await ttsSynthesize({ text: "un" });
        const b = await ttsSynthesize({ text: "deux" });
        expect(ttsGet(a!.hash)).toBeUndefined(); // oldest evicted
        expect(ttsGet(b!.hash)).toBeDefined();
      },
    );
    (env as { TTS_CACHE_MB: number }).TTS_CACHE_MB = cap;
  });
});
