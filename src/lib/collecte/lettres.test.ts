import { describe, expect, test } from "bun:test";
import { divergencePpm, lettres, DIVERGENCE_MAX_PPM } from "./lettres.ts";

const BRUTE = "Nisy indray mandeha, hono, lehilahy roa nifaninana tamin'ny hafetsena.";

describe("normalisation", () => {
  test("keeps letters and accents, drops everything else", () => {
    // The same character class as repparcs/scripts/validate.py: [^a-zà-ÿ].
    // Accents are letters in Malagasy and in French; dropping them would make
    // "hafetsena" and "hafétséna" the same word, which they are not.
    expect(lettres("Ny — vato, 1908 !")).toBe("nyvato");
    expect(lettres("hafétséna")).toBe("hafétséna");
  });
});

describe("what a correction may do", () => {
  test("layout repairs cost almost nothing", () => {
    // Rejoining a line break is the whole point of allowing corrections.
    const recolle = "Nisy indray mandeha, hono, lehilahy roa nifaninana tamin'ny hafetsena!";
    expect(divergencePpm(BRUTE, recolle)).toBeLessThan(DIVERGENCE_MAX_PPM);
  });

  test("an identical text is at zero", () => {
    expect(divergencePpm(BRUTE, BRUTE)).toBe(0);
  });

  test("a rewrite is refused even when the letter count is IDENTICAL", () => {
    // This is the case the upstream check cannot see. validate.py compares
    // lengths, and both sides here normalise to exactly 58 letters, so its
    // difference is 0 and it accepts the text — with every word changed.
    const reecrit = "Nosy andria mandola, hino, lehibiaka rea nifanovana taminy hafatsona.";
    expect(lettres(reecrit).length).toBe(lettres(BRUTE).length);
    expect(divergencePpm(BRUTE, reecrit)).toBeGreaterThan(DIVERGENCE_MAX_PPM);
  });

  test("a different telling of the same story is refused", () => {
    const autre = "Taloha ela be, nisy mpangalatra roa tao an-tanàna izay nifanandrina isan'andro.";
    expect(divergencePpm(BRUTE, autre)).toBeGreaterThan(DIVERGENCE_MAX_PPM);
  });

  test("emptying the text is not a correction", () => {
    expect(divergencePpm(BRUTE, "")).toBeGreaterThan(DIVERGENCE_MAX_PPM);
  });
});

describe("the threshold is the corpus's", () => {
  test("2 % expressed in parts per million", () => {
    expect(DIVERGENCE_MAX_PPM).toBe(20_000);
  });
});
