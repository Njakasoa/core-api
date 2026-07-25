import { afterEach, describe, expect, it } from "bun:test";
import { env } from "../../env.ts";
import { ttsCacheClear, ttsSetEnabledForTests } from "../../lib/tts.ts";
import type { StorySetup } from "./story.ts";
import { RoomVoice } from "./voice.ts";

const realFetch = globalThis.fetch;

function story(over: Partial<StorySetup> = {}): StorySetup {
  return {
    title: "La nuit d'Ambohitra",
    villageName: "Ambohitra",
    intro: "Le village s'endort sous une lune rouge.",
    roleEpithets: {},
    roleSheets: {},
    ambiance: { night: "La nuit tombe.", dawn: "L'aube se lève.", debate: "On débat.", vote: "On vote." },
    nightSteps: { songomby: "Le Songomby rôde." },
    dayProgression: { night: [], dawn: [], debate: [], vote: [] },
    deaths: ["Un corps est retrouvé."],
    victoryVillage: "Le village triomphe.",
    victorySongomby: "Les monstres triomphent.",
    narratorScript: [],
    ...over,
  };
}

/** Enable the feature and stub the upstream; returns the synthesized texts. */
async function withUpstream(fn: (seen: string[]) => Promise<void>): Promise<void> {
  const key = env.ELEVENLABS_API_KEY;
  const voice = env.ELEVENLABS_VOICE_NARRATOR;
  (env as { ELEVENLABS_API_KEY?: string }).ELEVENLABS_API_KEY = "test-key";
  (env as { ELEVENLABS_VOICE_NARRATOR?: string }).ELEVENLABS_VOICE_NARRATOR = "test-voice";
  ttsSetEnabledForTests(true);
  const seen: string[] = [];
  globalThis.fetch = (async (_input: Request | string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
    seen.push(body.text ?? "");
    return new Response(new Uint8Array(16), { headers: { "content-type": "audio/mpeg" } });
  }) as typeof fetch;
  try {
    await fn(seen);
  } finally {
    globalThis.fetch = realFetch;
    ttsSetEnabledForTests(false);
    (env as { ELEVENLABS_API_KEY?: string }).ELEVENLABS_API_KEY = key;
    (env as { ELEVENLABS_VOICE_NARRATOR?: string }).ELEVENLABS_VOICE_NARRATOR = voice;
  }
}

afterEach(() => ttsCacheClear());

describe("angano/voice", () => {
  it("stays silent when text-to-speech is off", async () => {
    const key = env.ELEVENLABS_API_KEY;
    (env as { ELEVENLABS_API_KEY?: string }).ELEVENLABS_API_KEY = undefined;
    const v = new RoomVoice();
    expect(v.enabled).toBe(false);
    await v.warm(story());
    expect(v.urlFor("Le village s'endort sous une lune rouge.")).toBeUndefined();
    (env as { ELEVENLABS_API_KEY?: string }).ELEVENLABS_API_KEY = key;
  });

  it("voices the opening lines and exposes them by exact text", async () => {
    await withUpstream(async () => {
      const v = new RoomVoice();
      await v.warm(story());
      expect(v.urlFor("Le village s'endort sous une lune rouge.")).toMatch(/^\/v1\/tts\/[a-f0-9]{32}$/);
      expect(v.urlFor("Le Songomby rôde.")).toMatch(/^\/v1\/tts\//);
      expect(v.urlFor("jamais prononcé")).toBeUndefined();
    });
  });

  it("speaks Malagasy names phonetically upstream while keying on the written line", async () => {
    await withUpstream(async (seen) => {
      const v = new RoomVoice();
      await v.warm(story({ nightSteps: { songomby: "Le Songomby rôde." } }));
      expect(seen.some((t) => t.includes("Sougoumbi"))).toBe(true);
      expect(v.urlFor("Le Songomby rôde.")).toBeDefined(); // lookup uses the displayed text
    });
  });

  it("matches on trimmed text so incidental whitespace still resolves", async () => {
    await withUpstream(async () => {
      const v = new RoomVoice();
      await v.warm(story());
      expect(v.urlFor("  Le Songomby rôde.  ")).toBeDefined();
    });
  });

  it("stops synthesizing once the room character budget is spent", async () => {
    const budget = env.ANGANO_TTS_CHAR_BUDGET;
    (env as { ANGANO_TTS_CHAR_BUDGET: number }).ANGANO_TTS_CHAR_BUDGET = 20;
    await withUpstream(async (seen) => {
      const v = new RoomVoice();
      await v.warm(story());
      expect(seen.length).toBeLessThan(4); // budget cut it short
    });
    (env as { ANGANO_TTS_CHAR_BUDGET: number }).ANGANO_TTS_CHAR_BUDGET = budget;
  });

  it("skips a single line longer than the per-line ceiling", async () => {
    await withUpstream(async () => {
      const v = new RoomVoice();
      const huge = "a".repeat(401);
      await v.warm(story({ intro: huge }));
      expect(v.urlFor(huge)).toBeUndefined();
    });
  });

  it("goes quiet after dispose", async () => {
    await withUpstream(async () => {
      const v = new RoomVoice();
      await v.warm(story());
      v.dispose();
      expect(v.urlFor("Le Songomby rôde.")).toBeUndefined();
      expect(await v.speak("autre chose")).toBeUndefined();
    });
  });
});
