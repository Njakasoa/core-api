import { describe, expect, test } from "bun:test";
import { appliquer, contexte } from "./corrections.ts";

describe("appliquer", () => {
  test("remplace un mot", () => {
    expect(appliquer("ny hontra ny afo", [{ debut: 3, fin: 9, propose: "hoatra" }]))
      .toBe("ny hoatra ny afo");
  });

  test("applique plusieurs corrections sans que les offsets dérivent", () => {
    // Le piège que le tri de la fin vers le début évite : corriger le premier
    // passage décale tous les suivants. En parcourant à l'endroit il faudrait
    // tenir un décalage courant, qui est exactement la variable qu'on oublie de
    // mettre à jour dans une branche.
    const base = "aaa bbb ccc";
    const rendu = appliquer(base, [
      { debut: 0, fin: 3, propose: "AAAAAA" },
      { debut: 8, fin: 11, propose: "C" },
    ]);
    expect(rendu).toBe("AAAAAA bbb C");
  });

  test("une proposition vide est une SUPPRESSION, pas une erreur", () => {
    // C'est la correction la plus fréquente sur ces pages : retirer du bruit
    // inséré par l'OCR. La refuser forcerait à l'exprimer en substitution.
    expect(appliquer("izy ä nandeha", [{ debut: 4, fin: 6, propose: "" }]))
      .toBe("izy nandeha");
  });

  test("corrige jusqu'au dernier caractère", () => {
    expect(appliquer("tamin ny", [{ debut: 5, fin: 8, propose: "' ny" }]))
      .toBe("tamin' ny");
  });

  test("des corrections adjacentes ne se marchent pas dessus", () => {
    expect(appliquer("ab", [
      { debut: 0, fin: 1, propose: "X" },
      { debut: 1, fin: 2, propose: "Y" },
    ])).toBe("XY");
  });

  test("sans correction, le texte est rendu tel quel", () => {
    expect(appliquer("inchangé", [])).toBe("inchangé");
  });
});

describe("contexte", () => {
  test("montre l'entourage et signale les troncatures", () => {
    const t = "a".repeat(100) + "hontra" + "b".repeat(100);
    const c = contexte(t, 100, 106, 10);
    expect(c.lu).toBe("hontra");
    expect(c.avant).toBe("…" + "a".repeat(10));
    expect(c.apres).toBe("b".repeat(10) + "…");
  });

  test("ne signale pas de troncature en début et fin de texte", () => {
    // « …ny fahavalony » et « ny fahavalony » ne disent pas la même chose à
    // quelqu'un qui décide si un mot commence bien là.
    const c = contexte("ny afo", 3, 6, 60);
    expect(c.avant).toBe("ny ");
    expect(c.apres).toBe("");
  });
});
