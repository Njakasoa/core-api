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

  it("folds the voice tuning into the hash so a re-tune is not served from cache", () => {
    const plain = ttsHash("a", "v", "m");
    const tuned = ttsHash("a", "v", "m", { stability: 0.3 });
    expect(tuned).not.toBe(plain);
    expect(ttsHash("a", "v", "m", { stability: 0.3 })).toBe(tuned);
    expect(ttsHash("a", "v", "m", { stability: 0.6 })).not.toBe(tuned);
  });

  it("omits voice_settings entirely when none is configured", async () => {
    // Pin every knob off: a developer's local .env must not change the outcome.
    const before = { st: env.ELEVENLABS_STABILITY, si: env.ELEVENLABS_SIMILARITY, sy: env.ELEVENLABS_STYLE, sp: env.ELEVENLABS_SPEED };
    const e = env as Pick<typeof env, "ELEVENLABS_STABILITY" | "ELEVENLABS_SIMILARITY" | "ELEVENLABS_STYLE" | "ELEVENLABS_SPEED">;
    e.ELEVENLABS_STABILITY = e.ELEVENLABS_SIMILARITY = e.ELEVENLABS_STYLE = e.ELEVENLABS_SPEED = undefined;

    const sent: Record<string, unknown>[] = [];
    await withUpstream(
      async (req) => { sent.push(JSON.parse(await req.text())); return mp3(); },
      async () => { await ttsSynthesize({ text: "sans réglage" }); },
    );
    expect(sent[0]).toBeDefined();
    expect("voice_settings" in sent[0]!).toBe(false); // let the voice keep its defaults

    e.ELEVENLABS_STABILITY = before.st; e.ELEVENLABS_SIMILARITY = before.si;
    e.ELEVENLABS_STYLE = before.sy; e.ELEVENLABS_SPEED = before.sp;
  });

  it("sends the configured voice settings upstream", async () => {
    const before = { st: env.ELEVENLABS_STABILITY, sp: env.ELEVENLABS_SPEED };
    (env as { ELEVENLABS_STABILITY?: number }).ELEVENLABS_STABILITY = 0.35;
    (env as { ELEVENLABS_SPEED?: number }).ELEVENLABS_SPEED = 0.92;

    const sent: Record<string, unknown>[] = [];
    await withUpstream(
      async (req) => { sent.push(JSON.parse(await req.text())); return mp3(); },
      async () => { await ttsSynthesize({ text: "avec réglages" }); },
    );
    expect(sent[0]?.voice_settings).toEqual({ stability: 0.35, speed: 0.92 });

    (env as { ELEVENLABS_STABILITY?: number }).ELEVENLABS_STABILITY = before.st;
    (env as { ELEVENLABS_SPEED?: number }).ELEVENLABS_SPEED = before.sp;
  });

  it("sends the pronunciation dictionary, and the text unaltered", async () => {
    const before = { id: env.ELEVENLABS_DICT_ID, v: env.ELEVENLABS_DICT_VERSION };
    const e = env as Pick<typeof env, "ELEVENLABS_DICT_ID" | "ELEVENLABS_DICT_VERSION">;
    e.ELEVENLABS_DICT_ID = "dict-1"; e.ELEVENLABS_DICT_VERSION = "v-1";

    const sent: Record<string, unknown>[] = [];
    await withUpstream(
      async (req) => { sent.push(JSON.parse(await req.text())); return mp3(); },
      async () => { await ttsSynthesize({ text: "Les Songomby quittent les roseaux." }); },
    );
    expect(sent[0]?.pronunciation_dictionary_locators)
      .toEqual([{ pronunciation_dictionary_id: "dict-1", version_id: "v-1" }]);
    // The whole point: the correction happens upstream, so the text goes out written
    // as it is displayed. A respelled "Sougoumbi" here would mean the old table is back.
    expect(sent[0]?.text).toBe("Les Songomby quittent les roseaux.");

    e.ELEVENLABS_DICT_ID = before.id; e.ELEVENLABS_DICT_VERSION = before.v;
  });

  it("omits the locator when no dictionary is configured", async () => {
    const before = { id: env.ELEVENLABS_DICT_ID, v: env.ELEVENLABS_DICT_VERSION };
    const e = env as Pick<typeof env, "ELEVENLABS_DICT_ID" | "ELEVENLABS_DICT_VERSION">;
    e.ELEVENLABS_DICT_ID = undefined; e.ELEVENLABS_DICT_VERSION = undefined;

    const sent: Record<string, unknown>[] = [];
    await withUpstream(
      async (req) => { sent.push(JSON.parse(await req.text())); return mp3(); },
      async () => { await ttsSynthesize({ text: "sans dictionnaire" }); },
    );
    expect("pronunciation_dictionary_locators" in sent[0]!).toBe(false);

    e.ELEVENLABS_DICT_ID = before.id; e.ELEVENLABS_DICT_VERSION = before.v;
  });

  it("folds the dictionary version into the hash, so a new one is not served stale", () => {
    const none = ttsHash("a", "v", "m");
    const v1 = ttsHash("a", "v", "m", undefined, "v-1");
    const v2 = ttsHash("a", "v", "m", undefined, "v-2");
    expect(v1).not.toBe(none);
    expect(v2).not.toBe(v1);
    expect(ttsHash("a", "v", "m", undefined, "v-1")).toBe(v1);
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
