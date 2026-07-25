import { describe, expect, it } from "bun:test";
import { toSpeakable } from "./pronunciation.ts";

describe("angano/pronunciation", () => {
  it("respells Malagasy o as ou and final y as i", () => {
    expect(toSpeakable("Le Songomby chasse.")).toBe("Le Sougoumbi chasse.");
    expect(toSpeakable("le mpisikidy lit le sikidy")).toBe("le mpissikidi lit le sikidi");
  });

  it("keeps the original capitalization", () => {
    expect(toSpeakable("Kinoly")).toBe("Kinouli");
    expect(toSpeakable("kinoly")).toBe("kinouli");
    expect(toSpeakable("KINOLY")).toBe("KINOULI");
  });

  it("prefers the longest match so compound names win", () => {
    expect(toSpeakable("Zazavavindrano")).toBe("Zazavavindranou");
  });

  it("only replaces whole words", () => {
    expect(toSpeakable("fadyx ody")).toBe("fadyx oudi");
  });

  it("leaves ordinary French untouched", () => {
    const line = "Le village se réveille et découvre les morts de la nuit.";
    expect(toSpeakable(line)).toBe(line);
  });

  it("handles empty input", () => {
    expect(toSpeakable("")).toBe("");
  });
});
