import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { db } from "../src/db/index.ts";
import { corpusRoles, objets, livres, pageOcr, pages } from "../src/db/schema.ts";
import { eq, sql } from "drizzle-orm";
import { id } from "../src/lib/ids.ts";
import { sha256Bytes } from "../src/lib/crypto.ts";
import { env } from "../src/env.ts";

/**
 * La bibliothèque protège autre chose que la collecte.
 *
 * Dans collecte, la frontière protège le CONTRIBUTEUR : sa soumission lui
 * appartient tant qu'elle n'est pas acceptée. Ici elle protège des AYANTS DROIT
 * qui ne sont pas dans la boucle — un livre de 1980 dont on ignore la date de
 * décès de l'auteur ne devient pas libre parce qu'on l'a numérisé.
 *
 * Ces tests portent donc surtout sur ce qui NE DOIT PAS sortir. C'est la classe
 * de défaut la plus silencieuse : rien n'échoue quand une API se met à servir
 * trop.
 */
const app = createApp();

let n = 0;
async function compte(role?: string) {
  const email = `bib${Date.now()}_${n++}@core.test`;
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
  if (role) {
    await db.insert(corpusRoles).values({
      id: id("crole"), userId: b.user.id, role, grantedByUserId: b.user.id,
    });
  }
  return {
    headers: { Authorization: `Bearer ${b.accessToken}`, "content-type": "application/json" },
  };
}

const LIVRE_LIBRE = {
  sourceRef: `bpt6k${Date.now()}`,
  source: "gallica" as const,
  titre: "Fampandrian-tany sy tantara maro samy hafa",
  annee: 1920,
  statutFixation: "DOMAINE_PUBLIC" as const,
  licence: "domaine public",
  licenceConstatee: "domaine public (notice Gallica, lue le 2026-08-02)",
  publiable: true,
};

const LIVRE_SOUS_DROITS = {
  sourceRef: `ny_voary_${Date.now()}`,
  source: "scan_local" as const,
  titre: "Ny Voary",
  annee: 1980,
  statutFixation: "SOUS_DROITS_A_ETABLIR" as const,
  licence: "inconnue",
  publiable: false,
  motifNonPubliable:
    "Date de décès de l'auteur non établie. Loi 94-036 art. 52 : vie + 70 ans.",
};

let graine = 0;

/**
 * Des octets d'image différents à chaque exécution.
 *
 * La base n'est jamais nettoyée entre deux `bun test`, et une image est adressée
 * PAR SON CONTENU : des octets figés donneraient la même ligne `objets` à toutes
 * les exécutions, et les pages laissées par la précédente — dont celle d'un
 * livre volontairement fermé — décideraient de la publication à la place du cas
 * en cours. Le premier passage était vert, le second rouge, et l'échec
 * ressemblait à un défaut de la route.
 *
 * On garde 0x80 et 0xFE : ce sont les octets qui distinguent un vrai sha256
 * d'un sha256 calculé sur une chaîne latin1 réencodée en utf8.
 */
function octetsUniques(): Uint8Array {
  const marque = Buffer.from(`${Date.now()}-${graine++}`);
  return new Uint8Array([0xff, 0xd8, 0x80, 0xfe, ...marque, 0xff, 0xd9]);
}

/**
 * Verse des octets d'image en base, comme le fera le script de versement.
 *
 * `contenu` est un `bytea` déclaré `text` côté Drizzle : passer une chaîne JS
 * lui ferait appliquer la syntaxe d'entrée bytea et stockerait silencieusement
 * autre chose. Les octets passent donc par un fragment `sql`.
 */
async function verserImage(octets: Uint8Array): Promise<string> {
  const h = sha256Bytes(octets);
  await db.execute(sql`
    insert into objets (sha256, mime, octets, classe, contenu)
    values (${h}, 'image/jpeg', ${octets.length}, 'original', ${Buffer.from(octets)})
    on conflict (sha256) do nothing
  `);
  return h;
}

async function creerLivre(h: Record<string, string>, corps: object) {
  const r = await app.request("/v1/bibliotheque/livres", {
    method: "POST", headers: h, body: JSON.stringify(corps),
  });
  return { statut: r.status, corps: (await r.json()) as { id: string } };
}

describe("qui peut verser un livre", () => {
  /**
   * LA RÈGLE A CHANGÉ, ET CE TEST DIT LAQUELLE.
   *
   * Il exigeait un 403 : seul un curateur pouvait verser. Le dépôt est
   * désormais ouvert à tout compte réel, parce que sans lui les ~400 angano
   * manquants restent inatteignables — aucun corpus libre de droits ne les
   * contient. Ce qui a remplacé le refus n'est pas rien : le livre existe mais
   * n'est LISTÉ nulle part avant d'avoir été jugé, et c'est cela qu'on vérifie
   * ici plutôt qu'un code d'état.
   */
  test("un compte ordinaire dépose — mais rien n'est publié pour autant", async () => {
    const moi = await compte();
    const { statut, corps } = await creerLivre(moi.headers, {
      ...LIVRE_LIBRE,
      sourceRef: `ordinaire-${Date.now()}`,
    });
    expect(statut).toBe(201);
    expect((corps as { statutModeration?: string }).statutModeration).toBe("en_attente");
    // Le public ne le voit pas — c'est la moitié qui compte.
    expect((await app.request(`/v1/bibliotheque/livres/${corps.id}`)).status).toBe(404);
  });

  test("un anonyme non plus, et il reçoit 401 et non 403", async () => {
    const r = await app.request("/v1/bibliotheque/livres", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(LIVRE_LIBRE),
    });
    expect(r.status).toBe(401);
  });

  test("un curateur verse, et son livre est public d'emblée", async () => {
    // Son travail EST la vérification : le faire passer par une file qu'il
    // viderait seul n'ajouterait rien.
    const cur = await compte("curateur");
    const { statut, corps } = await creerLivre(cur.headers, {
      ...LIVRE_LIBRE,
      sourceRef: `curateur-${Date.now()}`,
    });
    expect(statut).toBe(201);
    expect((corps as { statutModeration?: string }).statutModeration).toBe("accepte");
    expect((await app.request(`/v1/bibliotheque/livres/${corps.id}`)).status).toBe(200);
  });

  test("un livre non publiable doit dire pourquoi", async () => {
    // Un livre retiré sans motif est un livre dont personne ne saura, dans six
    // mois, s'il peut ressortir.
    const cur = await compte("curateur");
    const { motifNonPubliable: _sans, ...sansMotif } = LIVRE_SOUS_DROITS;
    const r = await app.request("/v1/bibliotheque/livres", {
      method: "POST", headers: cur.headers,
      body: JSON.stringify({ ...sansMotif, sourceRef: `x${Date.now()}` }),
    });
    expect(r.status).toBe(400);
  });
});

describe("ce qui ne sort pas", () => {
  test("un livre sous droits est invisible, et répond 404 et non 403", async () => {
    // 403 dirait « il existe et vous n'y avez pas droit ». Sur un ouvrage dont
    // les ayants droit ne sont pas dans la boucle, l'existence même est une
    // information qu'on ne donne pas.
    const cur = await compte("curateur");
    const { corps } = await creerLivre(cur.headers, LIVRE_SOUS_DROITS);
    const vu = await app.request(`/v1/bibliotheque/livres/${corps.id}`);
    expect(vu.status).toBe(404);

    const liste = await app.request("/v1/bibliotheque/livres?limit=100");
    const { data } = (await liste.json()) as { data: { id: string }[] };
    expect(data.some((l) => l.id === corps.id)).toBe(false);
  });

  test("une page publiable dans un livre qui ne l'est pas est refusée par la base", async () => {
    const cur = await compte("curateur");
    const { corps } = await creerLivre(cur.headers, {
      ...LIVRE_SOUS_DROITS, sourceRef: `nv${Date.now()}`,
    });
    const r = await app.request(`/v1/bibliotheque/livres/${corps.id}/pages`, {
      method: "POST", headers: cur.headers,
      body: JSON.stringify({ folio: 3, publiable: true }),
    });
    // `>= 400` passait sur un 500, ce qui était exactement le cas : la règle
    // venait d'un déclencheur, et rien ne traduisait une erreur Postgres. Le
    // message du déclencheur est écrit en français pour être lu ; il doit
    // arriver au client.
    expect(r.status).toBe(422);
    const b = (await r.json()) as { error: { code: string; message: string } };
    expect(b.error.code).toBe("regle_du_corpus");
    expect(b.error.message).toMatch(/livre non publiable/);
  });

  test("l'image d'un livre sous droits n'est pas servie, même avec son empreinte", async () => {
    // L'empreinte imprévisible sert d'autorisation pour une balise <img>, mais
    // elle ne suffit pas ici : elle circule dès qu'un curateur la voit.
    const cur = await compte("curateur");
    const { corps } = await creerLivre(cur.headers, {
      ...LIVRE_SOUS_DROITS, sourceRef: `img${Date.now()}`,
    });
    const page = await app.request(`/v1/bibliotheque/livres/${corps.id}/pages`, {
      method: "POST", headers: cur.headers, body: JSON.stringify({ folio: 7 }),
    });
    const { id: pageId } = (await page.json()) as { id: string };

    const empreinte = "a".repeat(64);
    await db.insert(objets).values({
      sha256: empreinte, mime: "image/png", octets: 3, contenu: sql`'\\x001122'::bytea` as never,
    }).onConflictDoNothing();
    await db.update(pages).set({ imageSha256: empreinte }).where(eq(pages.id, pageId));

    const r = await app.request(`/v1/objets/${empreinte}`);
    expect(r.status).toBe(404);
  });
});

describe("ce que la bibliothèque avoue", () => {
  test("un livre dit combien de pages ont une image, et combien n'en ont pas", async () => {
    // Une bibliothèque qui n'affiche que ce qu'elle possède laisse croire
    // qu'elle possède tout. Les 1 782 images Gallica ont été téléchargées puis
    // jetées ; la quasi-totalité des pages n'en a pas.
    const cur = await compte("curateur");
    const { corps } = await creerLivre(cur.headers, {
      ...LIVRE_LIBRE, sourceRef: `cnt${Date.now()}`,
    });
    for (const folio of [1, 2, 3]) {
      await app.request(`/v1/bibliotheque/livres/${corps.id}/pages`, {
        method: "POST", headers: cur.headers,
        body: JSON.stringify({ folio, texteOcr: folio === 1 ? "Nisy indray mandeha" : undefined }),
      });
    }
    const r = await app.request(`/v1/bibliotheque/livres/${corps.id}`);
    const b = (await r.json()) as {
      pagesConnues: number; pagesAvecImage: number; pagesAvecTexte: number;
    };
    expect(b.pagesConnues).toBe(3);
    expect(b.pagesAvecImage).toBe(0);
    expect(b.pagesAvecTexte).toBe(1);
  });

  test("une page sans image renvoie vers la source plutôt que de se taire", async () => {
    const cur = await compte("curateur");
    const { corps } = await creerLivre(cur.headers, {
      // Référence unique par exécution : un index unique (source, sourceRef)
      // interdit le doublon, et un identifiant figé faisait échouer le second
      // passage de la suite — l'échec ressemblait alors à un défaut de l'API.
      ...LIVRE_LIBRE, sourceRef: `bpt6k${Date.now()}src`,
    });
    const p = await app.request(`/v1/bibliotheque/livres/${corps.id}/pages`, {
      method: "POST", headers: cur.headers, body: JSON.stringify({ folio: 12 }),
    });
    const { id: pageId } = (await p.json()) as { id: string };
    const r = await app.request(`/v1/bibliotheque/pages/${pageId}`);
    const b = (await r.json()) as { imageUrl: string | null; urlSource: string | null };
    expect(b.imageUrl).toBeNull();
    expect(b.urlSource).toContain("gallica.bnf.fr");
    expect(b.urlSource).toContain("/f12.item");
  });

  test("toutes les passes d'océrisation sont publiées, sans vainqueur désigné", async () => {
    // Deux correcteurs entraînés sur ce corpus ont été rejetés APRÈS avoir paru
    // meilleurs : +16,6 points de reconnaissance lexicale, −4,8 de fidélité au
    // document. Publier la comparaison permet de le voir ; publier un vainqueur
    // l'empêche.
    const cur = await compte("curateur");
    const { corps } = await creerLivre(cur.headers, {
      ...LIVRE_LIBRE, sourceRef: `ocr${Date.now()}`,
    });
    const p = await app.request(`/v1/bibliotheque/livres/${corps.id}/pages`, {
      method: "POST", headers: cur.headers, body: JSON.stringify({ folio: 4 }),
    });
    const { id: pageId } = (await p.json()) as { id: string };
    await db.execute(sql`
      insert into page_ocr (id, page_id, moteur, texte, texte_sha256, created_at) values
        (${id("ocr")}, ${pageId}, 'tesseract-fra', 'Nisy indray mandeha', 'a', now()),
        (${id("ocr")}, ${pageId}, 'tesseract-eng', 'Nisy indray mandeha, hono', 'b', now() + interval '1 second')
    `);
    const r = await app.request(`/v1/bibliotheque/pages/${pageId}`);
    const b = (await r.json()) as { ocr: { moteur: string; accordDocument: number | null }[] };
    expect(b.ocr).toHaveLength(2);
    expect(b.ocr.map((o) => o.moteur)).toEqual(["tesseract-fra", "tesseract-eng"]);
    // Nul, parce qu'aucune transcription humaine n'existe pour cette page. Une
    // colonne nulle est une réponse : on ne sait pas.
    expect(b.ocr[0]?.accordDocument).toBeNull();
  });

  test("on n'océrise pas une page qui n'a pas d'image", async () => {
    const cur = await compte("curateur");
    const { corps } = await creerLivre(cur.headers, {
      ...LIVRE_LIBRE, sourceRef: `noimg${Date.now()}`,
    });
    const p = await app.request(`/v1/bibliotheque/livres/${corps.id}/pages`, {
      method: "POST", headers: cur.headers, body: JSON.stringify({ folio: 9 }),
    });
    const { id: pageId } = (await p.json()) as { id: string };
    const r = await app.request(`/v1/bibliotheque/pages/${pageId}/ocr`, {
      method: "POST", headers: cur.headers, body: JSON.stringify({ moteur: "tesseract-eng" }),
    });
    expect(r.status).toBe(422);
  });

  test("un moteur qui n'existe pas est refusé, plutôt que mis en file", async () => {
    // `moteur` était un texte libre : une coquille créait un travail qu'aucun
    // exécutant ne viendrait jamais prendre. Et « vision:… » n'est pas une
    // coquille — c'est un moteur que ce projet n'a pas : sa passerelle IA n'a
    // aucun chemin pour une image.
    const cur = await compte("curateur");
    const { corps } = await creerLivre(cur.headers, {
      ...LIVRE_LIBRE, sourceRef: `moteur${Date.now()}`,
    });
    const p = await app.request(`/v1/bibliotheque/livres/${corps.id}/pages`, {
      method: "POST", headers: cur.headers, body: JSON.stringify({ folio: 3 }),
    });
    const { id: pageId } = (await p.json()) as { id: string };
    const r = await app.request(`/v1/bibliotheque/pages/${pageId}/ocr`, {
      method: "POST", headers: cur.headers, body: JSON.stringify({ moteur: "vision:essai" }),
    });
    expect(r.status).toBe(400);
  });
});

describe("les octets d'image", () => {
  /** Un livre publiable, une page, et son image versée. */
  async function livreAvecImage(octets: Uint8Array, suffixe: string) {
    const cur = await compte("curateur");
    const { corps } = await creerLivre(cur.headers, {
      ...LIVRE_LIBRE, sourceRef: `${suffixe}${Date.now()}`,
    });
    const p = await app.request(`/v1/bibliotheque/livres/${corps.id}/pages`, {
      method: "POST", headers: cur.headers, body: JSON.stringify({ folio: 1 }),
    });
    const { id: pageId } = (await p.json()) as { id: string };
    const h = await verserImage(octets);
    await db.update(pages).set({ imageSha256: h }).where(eq(pages.id, pageId));
    return { cur, livreId: corps.id, pageId, h };
  }

  test("un octet ≥ 0x80 fait l'aller-retour et se re-hache identique", async () => {
    // Le test qui aurait attrapé `empreinteImage()` : elle relisait les octets
    // en latin1 puis les hachait en utf8, donc tout octet ≥ 0x80 comptait
    // double. Sur une image ASCII fictive le défaut est invisible ; sur un vrai
    // JPEG — dont le premier octet est 0xFF — il est systématique.
    const octets = octetsUniques();
    const { h } = await livreAvecImage(octets, "octets");

    const r = await app.request(`/v1/objets/${h}`);
    expect(r.status).toBe(200);
    const rendus = new Uint8Array(await r.arrayBuffer());
    expect(Array.from(rendus)).toEqual(Array.from(octets));
    expect(sha256Bytes(rendus)).toBe(h);
  });

  test("une image orpheline n'est pas servie", async () => {
    // `NOT EXISTS` est vrai à vide : sans la clause `EXISTS` séparée, une image
    // que plus aucune page ne référence sortirait.
    const h = await verserImage(octetsUniques());
    const r = await app.request(`/v1/objets/${h}`);
    expect(r.status).toBe(404);
  });

  test("une image partagée avec un livre fermé n'est plus servie du tout", async () => {
    // Les mêmes octets référencés depuis un livre ouvert ET un livre fermé :
    // l'une des deux étiquettes est fausse et rien ne dit laquelle. Refuser
    // coûte une tuile blanche, servir coûte un retrait.
    const octets = octetsUniques();
    const { cur, h } = await livreAvecImage(octets, "partage");
    expect((await app.request(`/v1/objets/${h}`)).status).toBe(200);

    const { corps: ferme } = await creerLivre(cur.headers, {
      ...LIVRE_SOUS_DROITS, sourceRef: `ferme${Date.now()}`,
    });
    const p2 = await app.request(`/v1/bibliotheque/livres/${ferme.id}/pages`, {
      method: "POST", headers: cur.headers, body: JSON.stringify({ folio: 1 }),
    });
    const { id: page2 } = (await p2.json()) as { id: string };
    await db.update(pages).set({ imageSha256: h }).where(eq(pages.id, page2));

    expect((await app.request(`/v1/objets/${h}`)).status).toBe(404);
  });

  test("une vignette est servie, alors qu'aucune page ne la porte en image_sha256", async () => {
    // L'empreinte d'une vignette n'apparaît que dans `vignette_sha256`.
    // Interroger la seule colonne `image_sha256` ferait répondre 404 à chaque
    // tuile de la grille — un défaut qui ne se voit qu'à l'écran.
    const octets = octetsUniques();
    const { pageId } = await livreAvecImage(octetsUniques(), "vign");
    const h = await verserImage(octets);
    await db.update(pages).set({ vignetteSha256: h }).where(eq(pages.id, pageId));

    const r = await app.request(`/v1/objets/${h}`);
    expect(r.status).toBe(200);

    const page = await app.request(`/v1/bibliotheque/pages/${pageId}`);
    const b = (await page.json()) as { vignetteUrl: string | null };
    expect(b.vignetteUrl).toBe(`/v1/objets/${h}`);
  });

  test("une image est rendable depuis une autre origine", async () => {
    // `secureHeaders()` pose Cross-Origin-Resource-Policy: same-origin sur
    // toute réponse. La route renvoyait alors 200, le bon Content-Type et les
    // bons octets — et la tuile restait blanche dans le navigateur. C'est la
    // classe de défaut la plus coûteuse à diagnostiquer : tout est vert côté
    // serveur. `Access-Control-Allow-Origin: *` n'y change rien, CORP est une
    // porte distincte.
    const { h } = await livreAvecImage(octetsUniques(), "corp");
    const r = await app.request(`/v1/objets/${h}`);
    expect(r.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");

    // Et la relaxation reste étroite : le reste de l'API garde le défaut.
    const autre = await app.request("/v1/bibliotheque/livres?limit=1");
    expect(autre.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  });

  test("les images ont leur propre seau de limitation", async () => {
    // Une grille de 166 vignettes épuiserait le seau commun de 120/min — et
    // fermerait du même coup tout le reste de l'API au visiteur, puisque c'est
    // un seul compteur.
    const { h } = await livreAvecImage(octetsUniques(), "seau");
    const img = await app.request(`/v1/objets/${h}`);
    expect(img.headers.get("RateLimit-Limit")).toBe(String(env.RATE_LIMIT_IMAGES_MAX));

    const autre = await app.request("/v1/bibliotheque/livres?limit=1");
    expect(autre.headers.get("RateLimit-Limit")).toBe(String(env.RATE_LIMIT_MAX));
  });
});

describe("une passe d'océrisation ne s'efface pas", () => {
  async function pageAvecPasse(suffixe: string) {
    const cur = await compte("curateur");
    const { corps } = await creerLivre(cur.headers, {
      ...LIVRE_LIBRE, sourceRef: `${suffixe}${Date.now()}`,
    });
    const p = await app.request(`/v1/bibliotheque/livres/${corps.id}/pages`, {
      method: "POST", headers: cur.headers, body: JSON.stringify({ folio: 1 }),
    });
    const { id: pageId } = (await p.json()) as { id: string };
    const ocrId = id("ocr");
    await db.insert(pageOcr).values({
      id: ocrId, pageId, moteur: "tesseract-fra", texte: "Nisy indray mandeha",
      texteSha256: "x",
    });
    return { livreId: corps.id, pageId, ocrId };
  }

  test("la supprimer directement lève", async () => {
    const { ocrId } = await pageAvecPasse("del");
    let leve: string | null = null;
    try {
      await db.delete(pageOcr).where(eq(pageOcr.id, ocrId));
    } catch (e) {
      leve = String((e as Error).message);
    }
    expect(leve).toMatch(/append-only/);
    // Et la ligne est toujours là : le refus n'est pas cosmétique.
    expect(await db.select().from(pageOcr).where(eq(pageOcr.id, ocrId))).toHaveLength(1);
  });

  test("mais supprimer le livre l'emporte en cascade", async () => {
    // Un déclencheur qui lève TOUJOURS rendrait impossible le retrait exigé par
    // un ayant droit — et `statut_fixation = SOUS_DROITS_A_ETABLIR` existe
    // précisément pour les livres qu'il faudra peut-être retirer.
    // `pg_trigger_depth()` distingue les deux ; le comportement est vérifié ici
    // plutôt que supposé.
    const { livreId, ocrId } = await pageAvecPasse("casc");
    await db.delete(livres).where(eq(livres.id, livreId));
    const reste = await db.select().from(pageOcr).where(eq(pageOcr.id, ocrId));
    expect(reste).toHaveLength(0);
  });
});

describe("la file d'océrisation", () => {
  test("redemander la même passe rend le travail existant, pas un identifiant fantôme", async () => {
    // `onConflictDoNothing()` renvoyait quand même l'identifiant qu'on venait de
    // tirer : une référence qui n'existe dans aucune table. Et 202 (« ce sera
    // fait ») était faux, puisque rien de neuf n'allait se produire.
    const cur = await compte("curateur");
    const { corps } = await creerLivre(cur.headers, {
      ...LIVRE_LIBRE, sourceRef: `file${Date.now()}`,
    });
    const p = await app.request(`/v1/bibliotheque/livres/${corps.id}/pages`, {
      method: "POST", headers: cur.headers, body: JSON.stringify({ folio: 1 }),
    });
    const { id: pageId } = (await p.json()) as { id: string };
    const h = await verserImage(octetsUniques());
    await db.update(pages).set({ imageSha256: h }).where(eq(pages.id, pageId));

    const corpsOcr = JSON.stringify({ moteur: "tesseract-eng" });
    const un = await app.request(`/v1/bibliotheque/pages/${pageId}/ocr`, {
      method: "POST", headers: cur.headers, body: corpsOcr,
    });
    expect(un.status).toBe(202);
    const premier = (await un.json()) as { id: string };

    const deux = await app.request(`/v1/bibliotheque/pages/${pageId}/ocr`, {
      method: "POST", headers: cur.headers, body: corpsOcr,
    });
    expect(deux.status).toBe(200);
    const second = (await deux.json()) as { id: string; deja: boolean };
    expect(second.id).toBe(premier.id);
    expect(second.deja).toBe(true);
  });
});
