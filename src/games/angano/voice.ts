import { env } from "../../env.ts";
import { ttsEnabled, ttsSynthesize } from "../../lib/tts.ts";
import { toSpeakable } from "./pronunciation.ts";
import type { StorySetup } from "./story.ts";

/**
 * Spoken narration for one Angano room.
 *
 * The AI story is written up-front, so every line the game can ever speak is known
 * before the first night falls. We synthesize them during the `roles` phase and the
 * game then reads URLs out of a map — playback is instant at the dramatic beat
 * instead of buffering into it.
 *
 * Two rules keep this from ever hurting a game:
 *   - only a small *priority* set is awaited; everything else warms in the
 *     background, and a line that is not ready simply has no voice.
 *   - a per-room character budget caps the bill, so a pathological story cannot
 *     run up an invoice.
 */

/** Cap per line — a runaway AI string should not eat the whole room budget. */
const MAX_LINE_CHARS = 400;
/** Parallel synthesis requests; keeps the warm-up short without hammering upstream. */
const CONCURRENCY = 4;
/** How long `start()` will wait on the opening lines before letting the game run. */
const WARM_BUDGET_MS = 12_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RoomVoice {
  private urls = new Map<string, string>();
  private spent = 0;
  private disposed = false;

  get enabled(): boolean {
    return ttsEnabled();
  }

  dispose(): void {
    this.disposed = true;
    this.urls.clear();
    this.spent = 0;
  }

  /** URL for an already-synthesized line, or undefined (caller shows text only). */
  urlFor(text: string): string | undefined {
    return this.urls.get(normalize(text));
  }

  /**
   * Synthesize the story's narration. Resolves once the *priority* lines (the intro
   * and the first beats the players will hear) are ready, or when `budgetMs` runs
   * out — whichever comes first, so a slow upstream can never stall the prep screen.
   * Whatever is still in flight keeps warming in the background. Never throws.
   */
  async warm(story: StorySetup, budgetMs = WARM_BUDGET_MS): Promise<void> {
    if (!this.enabled || this.disposed) return;

    const priority = [story.intro, ...Object.values(story.nightSteps), story.ambiance.night, story.ambiance.dawn];
    const background = [
      story.ambiance.debate,
      story.ambiance.vote,
      ...story.dayProgression.night,
      ...story.dayProgression.dawn,
      ...story.dayProgression.debate,
      ...story.dayProgression.vote,
      ...story.deaths,
      story.victoryVillage,
      story.victorySongomby,
    ];

    const warmed = this.synthesizeAll(priority).then(() => {
      if (!this.disposed) void this.synthesizeAll(background); // late lines just stay silent
    });
    await Promise.race([warmed, sleep(budgetMs)]);
  }

  /** Synthesize one line on demand — used for text not known when the story was written. */
  async speak(text: string): Promise<string | undefined> {
    if (!this.enabled || this.disposed) return undefined;
    const key = normalize(text);
    const known = this.urls.get(key);
    if (known) return known;
    await this.synthesizeOne(text);
    return this.urls.get(key);
  }

  private async synthesizeAll(lines: string[]): Promise<void> {
    const queue = [...new Set(lines.map(normalize).filter(Boolean))].filter((l) => !this.urls.has(l));
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (!this.disposed) {
        const line = queue[cursor++];
        if (line === undefined) return;
        await this.synthesizeOne(line);
      }
    });
    await Promise.all(workers);
  }

  private async synthesizeOne(text: string): Promise<void> {
    const line = normalize(text);
    if (!line || this.urls.has(line) || this.disposed) return;
    if (line.length > MAX_LINE_CHARS) return;
    if (this.spent + line.length > env.ANGANO_TTS_CHAR_BUDGET) return; // budget spent

    this.spent += line.length;
    const clip = await ttsSynthesize({ text: toSpeakable(line) });
    if (!clip || this.disposed) return;
    this.urls.set(line, `/v1/tts/${clip.hash}`);
  }
}

function normalize(text: string | undefined): string {
  return (text ?? "").trim();
}
