import { describe, expect, test } from "bun:test";
import { refusPhonotactique } from "./phonotactique.ts";

describe("ce qui peut être du malgache", () => {
  test("les neuf ethnies du corpus passent", () => {
    for (const e of ["antankarana","bara","betsileo","betsimisaraka","marofotsy",
                     "merina","sakalava","tanala","tsimihety"]) {
      expect(refusPhonotactique(e)).toBeNull();
    }
  });
  test("un dialecte inconnu du corpus passe aussi", () => {
    // Le contrôle ne décide pas depuis Antananarivo ce qui existe.
    for (const e of ["antefasy", "mahafaly", "antambahoaka", "vezo", "antanosy"]) {
      expect(refusPhonotactique(e)).toBeNull();
    }
  });
  test("les accents ne changent rien", () => {
    expect(refusPhonotactique("Betsimisàraka")).toBeNull();
  });
});

describe("ce qui ne peut pas l'être", () => {
  test("asdfgh — le cas qui a motivé ce fichier", () => {
    expect(refusPhonotactique("asdfgh")).toContain("voyelle");
  });
  test("les lettres absentes de l'alphabet malgache", () => {
    for (const m of ["qwerty", "uuuu", "wxcvbn"]) expect(refusPhonotactique(m)).not.toBeNull();
  });
  test("trop court, chiffres, ponctuation", () => {
    for (const m of ["ab", "12345", "a-b-c!", ""]) expect(refusPhonotactique(m)).not.toBeNull();
  });
  test("deux lettres répétées ne font pas un mot", () => {
    expect(refusPhonotactique("ababa")).toContain("deux lettres");
  });
  test("le refus dit POURQUOI, pas « invalide »", () => {
    // On refuse le nom d'ethnie que quelqu'un porte : lui répondre « invalide »
    // n'est pas une réponse qu'on peut donner.
    expect(refusPhonotactique("asdfgh")!.length).toBeGreaterThan(20);
  });
});
