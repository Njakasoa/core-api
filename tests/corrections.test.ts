import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { db } from "../src/db/index.ts";
import { corpusRoles, livres, pageCorrections, pageOcr, pages } from "../src/db/schema.ts";
import { eq, sql } from "drizzle-orm";
import { id } from "../src/lib/ids.ts";

/**
 * Corriger un texte océrisé : proposer, relire, sceller.
 *
 * CE QUE CES TESTS SURVEILLENT
 * N'importe qui connecté peut proposer. C'est la première porte de ce dépôt
 * ouverte à des inconnus, et toutes les règles qui la gardent vivent dans la
 * BASE : ancrage, immuabilité, non-chevauchement, plafonds. Un test qui
 * n'exercerait que le chemin heureux ne dirait rien de ce que la porte retient.
 *
 * Chaque cas ci-dessous vérifie donc surtout un REFUS, et vérifie aussi que le
 * refus arrive au client comme une phrase lisible plutôt qu'en 500 — un
 * contributeur ordinaire est désormais sur ce chemin.
 */
const app = createApp();

let n = 0;
async function compte(...roles: string[]) {
  const email = `corr${Date.now()}_${n++}@core.test`;
  const r = await app.request("/v1/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery" }),
  });
  // Un `register` qui échoue rendait `b.user.id` indéfini, et l'erreur
  // ressemblait alors à un défaut de l'API — alors que c'était le limiteur qui
  // avait épuisé son seau en fin de suite. On le dit ici, au bon endroit.
  if (!r.ok) throw new Error(`inscription impossible : HTTP ${r.status}`);
  const b = (await r.json()) as { accessToken: string; user: { id: string } };
  for (const role of roles) {
    await db.insert(corpusRoles).values({
      id: id("crole"), userId: b.user.id, role, grantedByUserId: b.user.id,
    });
  }
  return {
    userId: b.user.id,
    headers: { Authorization: `Bearer ${b.accessToken}`, "content-type": "application/json" },
  };
}

const TEXTE = "Nisy indray mandeha, hono, ny hontra ny afo tamin ny tanana.";

/**
 * Les offsets se CALCULENT, ils ne se comptent pas à la main.
 *
 * Première version de ce fichier : `hontra` annoncé en 31..37 alors qu'il est en
 * 30..36. Tous les cas ont échoué sur le déclencheur d'ancrage — qui a fait
 * exactement son travail, en disant « la lecture porte « ontra  », la
 * proposition dit avoir lu « hontra » ». C'est le genre d'erreur que ce
 * déclencheur existe pour rendre impossible côté production ; il serait absurde
 * de la réintroduire dans les tests.
 */
function intervalle(aiguille: string, remplacement: string) {
  const debut = TEXTE.indexOf(aiguille);
  if (debut < 0) throw new Error(`« ${aiguille} » absent du texte d'essai`);
  return { debut, fin: debut + aiguille.length, lu: aiguille, propose: remplacement };
}

/** Un livre publiable, une page, et une lecture de base réelle. */
async function pageAvecLecture(suffixe: string) {
  const cur = await compte("curateur");
  const r = await app.request("/v1/bibliotheque/livres", {
    method: "POST", headers: cur.headers,
    body: JSON.stringify({
      sourceRef: `${suffixe}${Date.now()}_${n++}`, source: "gallica",
      titre: "Tantaran'i tompokovavy Ratavy", annee: 1913,
      statutFixation: "DOMAINE_PUBLIC", licence: "domaine public", publiable: true,
    }),
  });
  const { id: livreId } = (await r.json()) as { id: string };
  const p = await app.request(`/v1/bibliotheque/livres/${livreId}/pages`, {
    method: "POST", headers: cur.headers, body: JSON.stringify({ folio: 1 }),
  });
  const { id: pageId } = (await p.json()) as { id: string };
  const ocrId = id("ocr");
  await db.insert(pageOcr).values({
    id: ocrId, pageId, moteur: "tesseract-fra", texte: TEXTE, texteSha256: "x",
  });
  return { livreId, pageId, ocrId, cur };
}

const HONTRA = intervalle("hontra", "hoatra");

async function proposer(
  h: Record<string, string>, pageId: string, ocrId: string, corps: object,
) {
  const r = await app.request(`/v1/bibliotheque/pages/${pageId}/corrections`, {
    method: "POST", headers: h,
    body: JSON.stringify({ baseOcrId: ocrId, ...corps }),
  });
  return { statut: r.status, corps: (await r.json()) as Record<string, unknown> };
}

describe("proposer est ouvert à qui est connecté", () => {
  test("un compte ordinaire, sans aucun rôle, peut proposer", async () => {
    const { pageId, ocrId } = await pageAvecLecture("ouvert");
    const moi = await compte();
    const { statut, corps } = await proposer(moi.headers, pageId, ocrId, HONTRA);
    expect(statut).toBe(201);
    expect(corps.statut).toBe("proposee");
  });

  test("un anonyme reçoit 401, et non 403", async () => {
    const { pageId, ocrId } = await pageAvecLecture("anon");
    const r = await app.request(`/v1/bibliotheque/pages/${pageId}/corrections`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseOcrId: ocrId, ...HONTRA }),
    });
    expect(r.status).toBe(401);
  });

  test("une proposition VIDE est une suppression, pas une erreur", async () => {
    // Retirer du bruit inséré par l'OCR est la correction la plus fréquente sur
    // ces pages. La refuser forcerait à l'exprimer en substitution.
    const { pageId, ocrId } = await pageAvecLecture("vide");
    const moi = await compte();
    const { statut } = await proposer(moi.headers, pageId, ocrId,
      intervalle("hono, ", ""));
    expect(statut).toBe(201);
  });
});

describe("ce que la base refuse, et ce que le client en lit", () => {
  test("un `lu` qui ne correspond pas à la lecture est refusé, en 422 lisible", async () => {
    // La règle la plus utile du lot : elle transforme « l'écart est détectable »
    // en « l'écart est inécrivable ». Et le message doit ARRIVER — jusqu'ici une
    // règle de la base remontait en 500 avec son texte masqué en production.
    const { pageId, ocrId } = await pageAvecLecture("ancre");
    const moi = await compte();
    const { statut, corps } = await proposer(moi.headers, pageId, ocrId, {
      ...HONTRA, lu: "XXXXXX",
    });
    expect(statut).toBe(422);
    const e = corps.error as { code: string; message: string };
    expect(e.code).toBe("regle_du_corpus");
    expect(e.message).toMatch(/la lecture porte/);
    expect(e.message).toMatch(/hontra/);
  });

  test("un intervalle qui déborde la lecture est refusé", async () => {
    const { pageId, ocrId } = await pageAvecLecture("deborde");
    const moi = await compte();
    const { statut, corps } = await proposer(moi.headers, pageId, ocrId, {
      debut: 5000, fin: 5006, lu: "hontra", propose: "hoatra",
    });
    expect(statut).toBe(422);
    expect((corps.error as { message: string }).message).toMatch(/déborde/);
  });

  test("une correction qui ne change rien est refusée par une contrainte", async () => {
    const { pageId, ocrId } = await pageAvecLecture("nul");
    const moi = await compte();
    const { statut, corps } = await proposer(moi.headers, pageId, ocrId, {
      ...HONTRA, propose: "hontra",
    });
    expect(statut).toBe(409);
    expect((corps.error as { code: string }).code).toBe("conflit_de_donnees");
  });

  test("le contenu d'une proposition ne se réécrit pas", async () => {
    const { pageId, ocrId } = await pageAvecLecture("fige");
    const moi = await compte();
    const { corps } = await proposer(moi.headers, pageId, ocrId, HONTRA);
    let leve: string | null = null;
    try {
      await db.update(pageCorrections)
        .set({ propose: "autre chose" })
        .where(eq(pageCorrections.id, corps.id as string));
    } catch (e) { leve = String((e as Error).message); }
    expect(leve).toMatch(/ne se réécrit pas/);
  });
});

describe("relire", () => {
  test("un accord accepte la correction, et le texte corrigé change", async () => {
    const { pageId, ocrId } = await pageAvecLecture("accord");
    const moi = await compte();
    const rel = await compte("relecteur");
    const { corps } = await proposer(moi.headers, pageId, ocrId, HONTRA);

    const a = await app.request(`/v1/bibliotheque/corrections/${corps.id}/avis`, {
      method: "POST", headers: rel.headers,
      body: JSON.stringify({ avis: "accord", motif: "hoatra est le mot" }),
    });
    expect(a.status).toBe(201);
    expect(((await a.json()) as { statut: string }).statut).toBe("acceptee");

    const vue = await app.request(`/v1/bibliotheque/pages/${pageId}`);
    const b = (await vue.json()) as {
      ocr: { texte: string }[];
      correction: { texte: string; editions: unknown[]; propositionsEnAttente: number };
    };
    expect(b.correction.texte).toContain("hoatra");
    expect(b.correction.editions).toHaveLength(1);
    // La lecture d'origine n'a PAS bougé, et n'est pas rejointe par la corrigée :
    // `ocr[]` porte l'affirmation « aucune n'est désignée juste ».
    expect(b.ocr).toHaveLength(1);
    expect(b.ocr[0]!.texte).toContain("hontra");
  });

  test("on ne relit pas sa propre proposition", async () => {
    const { pageId, ocrId } = await pageAvecLecture("soi");
    const rel = await compte("relecteur");
    const { corps } = await proposer(rel.headers, pageId, ocrId, HONTRA);
    const a = await app.request(`/v1/bibliotheque/corrections/${corps.id}/avis`, {
      method: "POST", headers: rel.headers, body: JSON.stringify({ avis: "accord" }),
    });
    expect(a.status).toBe(422);
    expect(((await a.json()) as { error: { message: string } }).error.message)
      .toMatch(/sa propre proposition/);
  });

  test("un compte sans le rôle relecteur ne décide pas", async () => {
    const { pageId, ocrId } = await pageAvecLecture("sansrole");
    const moi = await compte();
    const autre = await compte("curateur"); // curateur ≠ compétence en langue
    const { corps } = await proposer(moi.headers, pageId, ocrId, HONTRA);
    const a = await app.request(`/v1/bibliotheque/corrections/${corps.id}/avis`, {
      method: "POST", headers: autre.headers, body: JSON.stringify({ avis: "accord" }),
    });
    expect(a.status).toBe(403);
  });

  test("un désaccord refuse, et le texte ne bouge pas", async () => {
    const { pageId, ocrId } = await pageAvecLecture("refus");
    const moi = await compte();
    const rel = await compte("relecteur");
    const { corps } = await proposer(moi.headers, pageId, ocrId, {
      ...HONTRA, propose: "hoatra moderne",
    });
    await app.request(`/v1/bibliotheque/corrections/${corps.id}/avis`, {
      method: "POST", headers: rel.headers,
      body: JSON.stringify({ avis: "desaccord", motif: "modernise l'orthographe" }),
    });
    const vue = await app.request(`/v1/bibliotheque/pages/${pageId}`);
    const b = (await vue.json()) as { correction: { editions: unknown[] } };
    expect(b.correction.editions).toHaveLength(0);
  });

  test("deux corrections acceptées ne peuvent pas se chevaucher", async () => {
    const { pageId, ocrId } = await pageAvecLecture("chevauche");
    const un = await compte();
    const deux = await compte();
    const rel = await compte("relecteur");
    const a = await proposer(un.headers, pageId, ocrId, HONTRA);
    // Un second lecteur signale le MÊME passage autrement : c'est permis, et
    // c'est un signal. Ce qui est interdit, c'est de les accepter tous les deux.
    const decale = intervalle("ny hontra", "ny hoatra");
    // Une borne décalée d'un caractère : c'est le déclencheur d'ancrage qui
    // l'attrape, avant le canari `char_length(lu) = fin - debut`. Les deux
    // couvrent le cas ; celui qui parle en premier est celui qui dit quel texte
    // la lecture porte vraiment, ce qui est plus utile qu'un nom de contrainte.
    const b = await proposer(deux.headers, pageId, ocrId,
      { ...decale, fin: decale.fin + 1 });
    expect(b.statut).toBe(422);
    expect((b.corps.error as { message: string }).message).toMatch(/la lecture porte/);

    const b2 = await proposer(deux.headers, pageId, ocrId, decale);
    expect(b2.statut).toBe(201);

    await app.request(`/v1/bibliotheque/corrections/${a.corps.id}/avis`, {
      method: "POST", headers: rel.headers, body: JSON.stringify({ avis: "accord" }),
    });
    // La rivale devient sans objet plutôt que d'encombrer la file d'un
    // relecteur qui ne pourrait de toute façon plus l'accepter.
    const [rivale] = await db
      .select({ statut: pageCorrections.statut })
      .from(pageCorrections)
      .where(eq(pageCorrections.id, b2.corps.id as string));
    expect(rivale!.statut).toBe("obsolete");
  });

  test("une acceptation erronée peut être révoquée, et le passage re-proposé", async () => {
    // Sans révocation, un intervalle accepté à tort est verrouillé à vie : la
    // ligne est immuable et la contrainte d'exclusion interdit toute rivale.
    const { pageId, ocrId } = await pageAvecLecture("revoque");
    const moi = await compte();
    const rel = await compte("relecteur");
    const { corps } = await proposer(moi.headers, pageId, ocrId, HONTRA);
    await app.request(`/v1/bibliotheque/corrections/${corps.id}/avis`, {
      method: "POST", headers: rel.headers, body: JSON.stringify({ avis: "accord" }),
    });
    const rev = await app.request(
      `/v1/bibliotheque/corrections/${corps.id}/revocation`,
      { method: "POST", headers: rel.headers,
        body: JSON.stringify({ motif: "modernisation non repérée" }) },
    );
    expect(rev.status).toBe(200);

    const encore = await proposer(moi.headers, pageId, ocrId, HONTRA);
    expect(encore.statut).toBe(201);
  });

  test("l'auteur peut retirer sa proposition, un tiers non", async () => {
    const { pageId, ocrId } = await pageAvecLecture("retrait");
    const moi = await compte();
    const autre = await compte();
    const { corps } = await proposer(moi.headers, pageId, ocrId, HONTRA);
    const parAutre = await app.request(
      `/v1/bibliotheque/corrections/${corps.id}/retrait`,
      { method: "POST", headers: autre.headers },
    );
    expect(parAutre.status).toBe(404);
    const parMoi = await app.request(
      `/v1/bibliotheque/corrections/${corps.id}/retrait`,
      { method: "POST", headers: moi.headers },
    );
    expect(parMoi.status).toBe(200);
  });
});

describe("la file de relecture", () => {
  test("elle est réservée, et rend le contexte plutôt que des offsets", async () => {
    const { pageId, ocrId } = await pageAvecLecture("file");
    const moi = await compte();
    const rel = await compte("relecteur");
    await proposer(moi.headers, pageId, ocrId, HONTRA);

    const refuse = await app.request("/v1/bibliotheque/corrections", {
      headers: moi.headers,
    });
    expect(refuse.status).toBe(403);

    const r = await app.request(
      `/v1/bibliotheque/corrections?page=${pageId}`, { headers: rel.headers },
    );
    const b = (await r.json()) as {
      data: { lu: string; propose: string; contexte: { avant: string; apres: string } }[];
    };
    expect(b.data).toHaveLength(1);
    expect(b.data[0]!.contexte.avant).toContain("mandeha");
    expect(b.data[0]!.contexte.apres).toContain("afo");
  });
});

describe("sceller", () => {
  test("le scellement écrit une passe humaine, sans couronner personne", async () => {
    const { pageId, ocrId } = await pageAvecLecture("scelle");
    const moi = await compte();
    const rel = await compte("relecteur");
    const { corps } = await proposer(moi.headers, pageId, ocrId, HONTRA);
    await app.request(`/v1/bibliotheque/corrections/${corps.id}/avis`, {
      method: "POST", headers: rel.headers, body: JSON.stringify({ avis: "accord" }),
    });

    const s = await app.request(`/v1/bibliotheque/pages/${pageId}/relecture`, {
      method: "POST", headers: rel.headers, body: JSON.stringify({ baseOcrId: ocrId }),
    });
    expect(s.status).toBe(201);

    const vue = await app.request(`/v1/bibliotheque/pages/${pageId}`);
    const b = (await vue.json()) as {
      ocr: { moteur: string; texte: string }[];
      correction: { relectureScellee: { correctionsDepuis: number } };
    };
    expect(b.ocr.map((o) => o.moteur)).toEqual(["tesseract-fra", "humain:relecture"]);
    expect(b.ocr[1]!.texte).toContain("hoatra");
    expect(b.correction.relectureScellee.correctionsDepuis).toBe(0);
  });

  test("sceller deux fois ne fabrique pas deux transcriptions", async () => {
    const { pageId, ocrId } = await pageAvecLecture("idem");
    const moi = await compte();
    const rel = await compte("relecteur");
    const { corps } = await proposer(moi.headers, pageId, ocrId, HONTRA);
    await app.request(`/v1/bibliotheque/corrections/${corps.id}/avis`, {
      method: "POST", headers: rel.headers, body: JSON.stringify({ avis: "accord" }),
    });
    const corpsScel = JSON.stringify({ baseOcrId: ocrId });
    const un = await app.request(`/v1/bibliotheque/pages/${pageId}/relecture`, {
      method: "POST", headers: rel.headers, body: corpsScel,
    });
    const deux = await app.request(`/v1/bibliotheque/pages/${pageId}/relecture`, {
      method: "POST", headers: rel.headers, body: corpsScel,
    });
    expect(un.status).toBe(201);
    expect(deux.status).toBe(200);
    expect(((await deux.json()) as { deja: boolean }).deja).toBe(true);
  });

  test("sceller sans aucune correction acceptée n'a pas de sens", async () => {
    const { pageId, ocrId } = await pageAvecLecture("rien");
    const rel = await compte("relecteur");
    const s = await app.request(`/v1/bibliotheque/pages/${pageId}/relecture`, {
      method: "POST", headers: rel.headers, body: JSON.stringify({ baseOcrId: ocrId }),
    });
    expect(s.status).toBe(422);
  });
});

describe("le retrait d'un livre emporte ses corrections", () => {
  test("supprimer le livre efface les corrections en cascade", async () => {
    // `lu` et `propose` sont des copies du texte de la page. Les laisser debout
    // après un retrait exigé par un ayant droit garderait la page retirée en
    // base sous un autre nom de table.
    const { livreId, pageId, ocrId } = await pageAvecLecture("cascade");
    const moi = await compte();
    const { corps } = await proposer(moi.headers, pageId, ocrId, HONTRA);
    await db.delete(livres).where(eq(livres.id, livreId));
    const reste = await db
      .select({ id: pageCorrections.id })
      .from(pageCorrections)
      .where(eq(pageCorrections.id, corps.id as string));
    expect(reste).toHaveLength(0);
  });
});

describe("les rôles s'accordent enfin par une route", () => {
  test("un modérateur accorde et révoque ; un autre ne peut pas", async () => {
    const mod = await compte("moderateur");
    const cible = await compte();
    const quidam = await compte();

    const refuse = await app.request("/v1/corpus/roles", {
      method: "POST", headers: quidam.headers,
      body: JSON.stringify({ userId: cible.userId, role: "relecteur" }),
    });
    expect(refuse.status).toBe(403);

    const r = await app.request("/v1/corpus/roles", {
      method: "POST", headers: mod.headers,
      body: JSON.stringify({ userId: cible.userId, role: "relecteur" }),
    });
    expect(r.status).toBe(201);
    const { id: roleId } = (await r.json()) as { id: string };

    // Le rôle mord immédiatement.
    const { pageId, ocrId } = await pageAvecLecture("roleactif");
    const moi = await compte();
    const { corps } = await proposer(moi.headers, pageId, ocrId, HONTRA);
    const avis = await app.request(`/v1/bibliotheque/corrections/${corps.id}/avis`, {
      method: "POST", headers: cible.headers, body: JSON.stringify({ avis: "accord" }),
    });
    expect(avis.status).toBe(201);

    // Révoqué, il ne mord plus — mais la ligne reste, avec qui l'avait accordé.
    const d = await app.request(`/v1/corpus/roles/${roleId}`, {
      method: "DELETE", headers: mod.headers,
    });
    expect(d.status).toBe(200);
    const apres = await app.request(`/v1/bibliotheque/corrections`, {
      headers: cible.headers,
    });
    expect(apres.status).toBe(403);
    const [ligne] = await db
      .select({ revoke: corpusRoles.revokedAt })
      .from(corpusRoles)
      .where(eq(corpusRoles.id, roleId));
    expect(ligne!.revoke).not.toBeNull();
  });
});
