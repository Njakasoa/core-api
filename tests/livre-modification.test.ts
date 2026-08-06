import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../src/db/index.ts";
import { oublierClientDepot } from "../src/lib/stockage/depots.ts";
import { FENETRE_DEPOT_HEURES } from "../src/routes/objets.ts";
import { app, compte, deposerLivre, png, verser } from "./aides.ts";

/**
 * Défaire — corriger un livre, le retirer, le supprimer.
 *
 * LA BIBLIOTHÈQUE NE SAVAIT RIEN DÉFAIRE. Une coquille dans un titre était
 * définitive, un dépôt fait par erreur restait, et la production le montrait :
 * un seul livre, `Rakibolana`, accepté, zéro page, déclaré `LICENCE_CC` pour un
 * dictionnaire de 1985 dont les droits sont douteux — sans autre recours qu'un
 * UPDATE en SSH.
 *
 * CE QUE CES ESSAIS SURVEILLENT EST LE CONTRAIRE D'UNE FONCTIONNALITÉ QUI MARCHE :
 * ce sont, pour l'essentiel, des ABSENCES. Rien n'échoue quand une API se met à
 * servir des octets qu'elle ne devait plus servir. Les deux plus importants —
 * « l'empreinte cesse d'être servie AVANT que la boucle l'ait atteinte » et
 * « un échec à mi-course laisse le livre fermé » — portent sur l'ordre des
 * opérations, qui est la seule chose qui distingue « déplacé » de « perdu ».
 */

/** L'URL d'un livre, écrite une fois. */
const url = (id: string, suite = "") => `/v1/bibliotheque/livres/${id}${suite}`;

async function patch(h: Record<string, string>, id: string, corps: object) {
  const r = await app.request(url(id), {
    method: "PATCH",
    headers: h,
    body: JSON.stringify(corps),
  });
  return { statut: r.status, corps: (await r.json()) as Record<string, unknown> };
}

async function lire(h: Record<string, string> | undefined, id: string) {
  const r = await app.request(url(id), h ? { headers: h } : undefined);
  return { statut: r.status, corps: (await r.json()) as Record<string, unknown> };
}

async function ligne(id: string) {
  const [l] = await db.execute<Record<string, unknown>>(sql`
    select publiable, publiable_avant as "publiableAvant", retire_le as "retireLe",
           motif_retrait as "motifRetrait", motif_non_publiable as "motifNonPubliable",
           statut_moderation as "statutModeration", titre
      from livres where id = ${id}
  `);
  return l ?? null;
}

describe("corriger un livre", () => {
  test("le déposant corrige son titre, et rien d'autre ne bouge", async () => {
    const dep = await compte();
    const { corps: l } = await deposerLivre(dep.headers, { titre: "Angano nnaty" });
    const r = await patch(dep.headers, l.id, { titre: "Angano naty" });
    expect(r.statut).toBe(200);
    // La liste des champs touchés est RENDUE : un correctif qui écrit plus que
    // demandé ne se voit pas autrement.
    expect(r.corps.modifie).toEqual(["titre"]);
    expect((await ligne(l.id))?.titre).toBe("Angano naty");
  });

  test("renvoyer une valeur identique n'écrit rien", async () => {
    // Un formulaire renvoie volontiers tout son contenu. Écrire ce qui n'a pas
    // changé ferait bouger `updated_at` — et, sur un champ de droits, renverrait
    // le livre en modération pour rien.
    const dep = await compte();
    const { corps: l } = await deposerLivre(dep.headers, { titre: "Tantara" });
    const r = await patch(dep.headers, l.id, { titre: "Tantara" });
    expect(r.statut).toBe(200);
    expect(r.corps.modifie).toEqual([]);
  });

  test("le déposant ne peut pas toucher à la déclaration de droits", async () => {
    // C'est elle qui décide si les octets sortent. La laisser au déposant
    // reviendrait à pouvoir republier un livre refusé en changeant sa propre
    // étiquette.
    const dep = await compte();
    const { corps: l } = await deposerLivre(dep.headers);
    for (const champ of [
      { publiable: false, motifNonPubliable: "je me rétracte" },
      { statutFixation: "DOMAINE_PUBLIC" },
      { licence: "CC0" },
      { licenceConstatee: "vu sur le web" },
      { motifNonPubliable: "au cas où" },
    ]) {
      expect((await patch(dep.headers, l.id, champ)).statut).toBe(403);
    }
  });

  test("un curateur, lui, peut la corriger", async () => {
    const cur = await compte("curateur");
    const { corps: l } = await deposerLivre(cur.headers);
    const r = await patch(cur.headers, l.id, {
      statutFixation: "SOUS_DROITS",
      publiable: false,
      motifNonPubliable: "auteur mort en 1994",
    });
    expect(r.statut).toBe(200);
    expect((await ligne(l.id))?.publiable).toBe(false);
  });

  test("`source` et `sourceRef` sont refusés — c'est l'identité du dépôt", async () => {
    // Les changer ne corrigerait pas le livre : ça le ferait pointer vers un
    // autre ouvrage en gardant ses pages, ses océrisations et ses corrections.
    const cur = await compte("curateur");
    const { corps: l } = await deposerLivre(cur.headers);
    expect((await patch(cur.headers, l.id, { source: "gallica" })).statut).toBe(400);
    expect((await patch(cur.headers, l.id, { sourceRef: "bpt6k000000" })).statut).toBe(400);
  });

  test("un livre non publiable doit toujours dire pourquoi — vérifié sur la ligne fusionnée", async () => {
    const cur = await compte("curateur");
    const { corps: l } = await deposerLivre(cur.headers, { publiable: true });
    // Le correctif seul ne porte pas le motif : c'est la LIGNE qui doit le
    // porter, et elle ne l'a pas encore.
    expect((await patch(cur.headers, l.id, { publiable: false })).statut).toBe(422);
    // Avec le motif, la même demande passe.
    expect(
      (await patch(cur.headers, l.id, { publiable: false, motifNonPubliable: "droits à établir" }))
        .statut,
    ).toBe(200);
    // Et une fois le motif en base, `publiable: false` seul est licite — sans
    // quoi il faudrait le réécrire à chaque enregistrement.
    await patch(cur.headers, l.id, { publiable: true });
    expect((await patch(cur.headers, l.id, { publiable: false })).statut).toBe(200);
  });

  test("un facultatif s'efface par `null` — l'omettre veut dire « ne touche pas »", async () => {
    const dep = await compte();
    const { corps: l } = await deposerLivre(dep.headers, { auteur: "Anonyme" });
    await patch(dep.headers, l.id, { titre: "Autre" });
    const [avant] = await db.execute<{ auteur: string | null }>(
      sql`select auteur from livres where id = ${l.id}`,
    );
    expect(avant?.auteur).toBe("Anonyme");
    expect((await patch(dep.headers, l.id, { auteur: null })).statut).toBe(200);
    const [apres] = await db.execute<{ auteur: string | null }>(
      sql`select auteur from livres where id = ${l.id}`,
    );
    expect(apres?.auteur).toBeNull();
  });

  test("404 quand on ne voit pas le livre, 403 quand on le voit sans y avoir droit", async () => {
    // Les deux réponses ne disent pas la même chose, et les confondre a un coût
    // dans chaque sens : un 403 sur un livre caché confirme son identifiant à
    // qui le devine, un 404 sur un livre public est incompréhensible.
    const dep = await compte();
    const cur = await compte("curateur");
    const tiers = await compte();

    const { corps: cache } = await deposerLivre(dep.headers, { publiable: false, motifNonPubliable: "en cours" });
    expect((await patch(tiers.headers, cache.id, { titre: "x" })).statut).toBe(404);

    const { corps: visible } = await deposerLivre(cur.headers, { publiable: true });
    expect((await patch(tiers.headers, visible.id, { titre: "x" })).statut).toBe(403);
  });

  test("corriger les droits d'un livre ACCEPTÉ le renvoie en file de modération", async () => {
    // `statut_moderation` répond « quelqu'un a-t-il vérifié ». Vérifié quoi : la
    // déclaration telle qu'elle était. La changer après coup laisserait un livre
    // marqué « accepté » sur une déclaration que personne n'a jamais lue.
    const cur = await compte("curateur");
    const { corps: l } = await deposerLivre(cur.headers);
    expect((await ligne(l.id))?.statutModeration).toBe("accepte");

    const r = await patch(cur.headers, l.id, { licence: "CC BY-SA 4.0" });
    expect(r.statut).toBe(200);
    expect(r.corps.renvoyeEnModeration).toBe(true);
    expect((await ligne(l.id))?.statutModeration).toBe("en_attente");
  });

  test("corriger un titre ne renvoie RIEN en modération", async () => {
    const cur = await compte("curateur");
    const { corps: l } = await deposerLivre(cur.headers);
    const r = await patch(cur.headers, l.id, { titre: "Coquille réparée" });
    expect(r.corps.renvoyeEnModeration).toBe(false);
    expect((await ligne(l.id))?.statutModeration).toBe("accepte");
  });

  test("l'état de droits n'est rendu qu'à qui peut le changer", async () => {
    // Sans lui, un formulaire de correction afficherait des cases vides et les
    // enverrait telles quelles, effaçant la déclaration du déposant.
    const cur = await compte("curateur");
    const tiers = await compte();
    const { corps: l } = await deposerLivre(cur.headers, { publiable: true });

    const vuParLeCurateur = await lire(cur.headers, l.id);
    expect((vuParLeCurateur.corps.gestion as Record<string, unknown>).publiable).toBe(true);
    expect((vuParLeCurateur.corps.gestion as Record<string, unknown>).peutSupprimer).toBe(false);

    expect((await lire(tiers.headers, l.id)).corps.gestion).toBeNull();
    expect((await lire(undefined, l.id)).corps.gestion).toBeNull();
  });
});

describe("retirer un livre, et le rétablir", () => {
  test("le retrait n'écrase pas la déclaration du déposant", async () => {
    // C'était toute la faute des colonnes empruntées : « retiré » et « n'a jamais
    // eu le droit d'être publié » s'écrivaient au même endroit, et le second
    // motif disparaissait sous le premier.
    const dep = await compte();
    const { corps: l } = await deposerLivre(dep.headers, {
      publiable: false,
      motifNonPubliable: "droits de l'éditeur à vérifier",
    });
    const r = await app.request(url(l.id, "/retrait"), {
      method: "POST",
      headers: dep.headers,
      body: JSON.stringify({ motif: "l'ayant droit a écrit" }),
    });
    expect(r.status).toBe(200);
    const apres = await ligne(l.id);
    expect(apres?.motifNonPubliable).toBe("droits de l'éditeur à vérifier");
    expect(apres?.motifRetrait).toBe("l'ayant droit a écrit");
    expect(apres?.publiable).toBe(false);
    // Ce qu'un rétablissement rendrait : `false`, puisque le livre n'était PAS
    // publiable avant qu'on le retire.
    expect(apres?.publiableAvant).toBe(false);
  });

  test("un second retrait ne réécrit pas le premier", async () => {
    // Un double-clic perdrait sinon la date et l'auteur du retrait initial — les
    // deux seules choses qu'on demande le jour où il est contesté.
    const dep = await compte();
    const { corps: l } = await deposerLivre(dep.headers, { publiable: true });
    const un = await app.request(url(l.id, "/retrait"), {
      method: "POST", headers: dep.headers,
      body: JSON.stringify({ motif: "premier motif" }),
    });
    const premier = (await un.json()) as { retireLe: string };
    const deux = await app.request(url(l.id, "/retrait"), {
      method: "POST", headers: dep.headers,
      body: JSON.stringify({ motif: "second motif" }),
    });
    const second = (await deux.json()) as { retireLe: string; deja?: boolean; motif: string };
    expect(second.deja).toBe(true);
    expect(second.retireLe).toBe(premier.retireLe);
    expect(second.motif).toBe("premier motif");
  });

  test("un motif est obligatoire, et « x » n'en est pas un", async () => {
    const dep = await compte();
    const { corps: l } = await deposerLivre(dep.headers);
    for (const corps of [{}, { motif: "" }, { motif: "x" }]) {
      const r = await app.request(url(l.id, "/retrait"), {
        method: "POST", headers: dep.headers, body: JSON.stringify(corps),
      });
      expect(r.status).toBe(400);
    }
  });

  test("le rétablissement REFUSE un livre qui n'a jamais été retiré", async () => {
    // Sans cette garde, il devient la porte dérobée qu'il évite : appelé sur un
    // dépôt déclaré sous droits — `publiable = false`, motif rempli, exactement
    // la silhouette d'un retrait — il aurait publié ce que personne n'a autorisé.
    const cur = await compte("curateur");
    const { corps: l } = await deposerLivre(cur.headers, {
      publiable: false,
      motifNonPubliable: "sous droits, déclaré par le déposant",
    });
    const r = await app.request(url(l.id, "/retablissement"), {
      method: "POST", headers: cur.headers,
    });
    expect(r.status).toBe(422);
    expect((await ligne(l.id))?.publiable).toBe(false);
  });

  test("le rétablissement rend l'état d'AVANT, pas `true`", async () => {
    const cur = await compte("curateur");
    // Un livre non publiable, retiré, puis rétabli : il ne devient pas publiable.
    const { corps: ferme } = await deposerLivre(cur.headers, {
      publiable: false, motifNonPubliable: "à établir",
    });
    await app.request(url(ferme.id, "/retrait"), {
      method: "POST", headers: cur.headers, body: JSON.stringify({ motif: "réclamation" }),
    });
    await app.request(url(ferme.id, "/retablissement"), { method: "POST", headers: cur.headers });
    expect((await ligne(ferme.id))?.publiable).toBe(false);

    // Un livre publiable, retiré, puis rétabli : il le redevient.
    const { corps: ouvert } = await deposerLivre(cur.headers, { publiable: true });
    await app.request(url(ouvert.id, "/retrait"), {
      method: "POST", headers: cur.headers, body: JSON.stringify({ motif: "réclamation" }),
    });
    await app.request(url(ouvert.id, "/retablissement"), { method: "POST", headers: cur.headers });
    const apres = await ligne(ouvert.id);
    expect(apres?.publiable).toBe(true);
    expect(apres?.retireLe).toBeNull();
    expect(apres?.publiableAvant).toBeNull();
  });

  test("un correctif ne peut pas republier un livre retiré", async () => {
    // Ce serait contourner le rétablissement, qui restaure l'état d'avant plutôt
    // que d'en inventer un.
    const cur = await compte("curateur");
    const { corps: l } = await deposerLivre(cur.headers, { publiable: true });
    await app.request(url(l.id, "/retrait"), {
      method: "POST", headers: cur.headers, body: JSON.stringify({ motif: "réclamation" }),
    });
    expect((await patch(cur.headers, l.id, { publiable: true })).statut).toBe(422);
  });

  test("le rétablissement est réservé — un déposant ne se rétablit pas lui-même", async () => {
    const dep = await compte();
    const { corps: l } = await deposerLivre(dep.headers, { publiable: true });
    await app.request(url(l.id, "/retrait"), {
      method: "POST", headers: dep.headers, body: JSON.stringify({ motif: "je retire" }),
    });
    const r = await app.request(url(l.id, "/retablissement"), {
      method: "POST", headers: dep.headers,
    });
    expect(r.status).toBe(403);
  });
});

/**
 * La suppression définitive, éprouvée contre un VRAI stockage d'objet.
 *
 * Un faux seau en trente lignes : sans lui, ces essais tourneraient contre
 * `stockage = 'db'`, où aucun appel distant ne peut échouer — c'est-à-dire
 * précisément à côté de ce qu'on veut mesurer. Et jamais contre le seau réel :
 * un essai qui écrit en production n'est pas un essai.
 *
 * LA PANNE EST INJECTÉE DANS NOTRE CODE, PAS DANS LE CLIENT S3, et c'est une
 * correction. Une première version faisait répondre 500 au faux seau sur DELETE.
 * Ça marchait — la route rendait bien 500 — mais `Bun.S3Client` laissait
 * échapper un rejet que personne n'observe, et le lanceur l'attribuait à
 * l'essai en cours au moment où il remontait : ici le bon, sur l'intégration
 * continue trois autres, qui n'injectent aucune panne. Quatre essais rouges pour
 * une seule cause, et pas dans le fichier qu'on regardait.
 *
 * `sansDepot()` retire simplement les identifiants le temps de l'appel :
 * `depots.ts` lève alors une Error ordinaire, la nôtre, que la route attrape.
 * Aucune promesse interne au client n'entre en jeu — et l'essai mesure la même
 * chose : `supprimerObjet` échoue, la boucle s'arrête, le livre reste fermé.
 */
describe("supprimer un livre détruit ses octets", () => {
  const seau = "essai";
  const contenus = new Map<string, Uint8Array>();
  let serveur: ReturnType<typeof Bun.serve> | null = null;
  const envAvant: Record<string, unknown> = {};

  /** Le dépôt d'objets, injoignable le temps d'un appel.
   *  `T | Promise<T>` parce qu'`app.request` rend l'un ou l'autre selon la
   *  route : exiger une promesse ferait échouer le typage, pas l'essai. */
  async function sansDepot<T>(f: () => T | Promise<T>): Promise<T> {
    const { env } = await import("../src/env.ts");
    const garde = {
      R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
      R2_BUCKET: env.R2_BUCKET,
    };
    Object.assign(env, {
      R2_ACCESS_KEY_ID: undefined, R2_SECRET_ACCESS_KEY: undefined, R2_BUCKET: undefined,
    });
    oublierClientDepot();
    try {
      return await f();
    } finally {
      Object.assign(env, garde);
      oublierClientDepot();
    }
  }

  beforeAll(async () => {
    serveur = Bun.serve({
      port: 0,
      async fetch(req) {
        const chemin = new URL(req.url).pathname.replace(`/${seau}/`, "");
        if (req.method === "PUT") {
          contenus.set(chemin, new Uint8Array(await req.arrayBuffer()));
          return new Response(null, { status: 200 });
        }
        if (req.method === "DELETE") {
          contenus.delete(chemin);
          return new Response(null, { status: 204 });
        }
        const o = contenus.get(chemin);
        if (!o) {
          return new Response(
            `<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>`,
            { status: 404, headers: { "content-type": "application/xml" } },
          );
        }
        return new Response(o);
      },
    });

    // `env` a été figé à l'import ; on l'échange le temps de ce bloc et on le
    // REMET — un fichier d'essai qui laisse l'environnement modifié casse ceux
    // qui tournent après lui, dans un ordre que personne ne choisit.
    const { env } = await import("../src/env.ts");
    for (const k of [
      "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_ENDPOINT",
      "OBJETS_STOCKAGE",
    ]) {
      envAvant[k] = (env as unknown as Record<string, unknown>)[k];
    }
    Object.assign(env, {
      R2_ACCESS_KEY_ID: "essai",
      R2_SECRET_ACCESS_KEY: "essai-secret",
      R2_BUCKET: seau,
      R2_ENDPOINT: `http://127.0.0.1:${serveur.port}`,
      OBJETS_STOCKAGE: "r2",
    });
    oublierClientDepot();
  });

  afterAll(async () => {
    const { env } = await import("../src/env.ts");
    Object.assign(env, envAvant);
    oublierClientDepot();
    serveur?.stop(true);
  });

  /** Un livre avec `combien` folios, chacun portant une image versée. */
  async function livreAvecFolios(
    h: { headers: Record<string, string>; octets: { authorization: string } },
    combien: number,
  ) {
    const { corps: l } = await deposerLivre(h.headers, { publiable: true });
    const empreintes: string[] = [];
    for (let i = 0; i < combien; i++) {
      const { corps } = await verser(h.octets, png());
      empreintes.push(corps.sha256!);
      await app.request(url(l.id, "/pages"), {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify({ folio: i + 1, imageSha256: corps.sha256 }),
      });
    }
    return { id: l.id, empreintes };
  }

  async function objetExiste(sha: string) {
    const [r] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from objets where sha256 = ${sha}`,
    );
    return (r?.n ?? 0) > 0;
  }

  const supprimer = (h: Record<string, string>, id: string, motif = "revendication de droits") =>
    app.request(url(id), { method: "DELETE", headers: h, body: JSON.stringify({ motif }) });

  test("un modérateur supprime : les octets partent, le livre aussi, la trace reste", async () => {
    const cur = await compte("curateur");
    const mod = await compte("moderateur");
    const { id, empreintes } = await livreAvecFolios(cur, 3);
    expect(await objetExiste(empreintes[0]!)).toBe(true);

    const r = await supprimer(mod.headers, id);
    expect(r.status).toBe(200);
    const corps = (await r.json()) as { objetsDetruits: number; pagesSupprimees: number };
    expect(corps.objetsDetruits).toBe(3);
    expect(corps.pagesSupprimees).toBe(3);

    for (const e of empreintes) expect(await objetExiste(e)).toBe(false);
    expect(await ligne(id)).toBeNull();

    const [trace] = await db.execute<{ motif: string; objetsDetruits: number }>(sql`
      select motif, objets_detruits as "objetsDetruits"
        from livres_supprimes where livre_id = ${id}
    `);
    expect(trace?.motif).toBe("revendication de droits");
    expect(trace?.objetsDetruits).toBe(3);
  });

  test("un curateur ne supprime pas — détruire le travail de tiers n'est pas de l'édition", async () => {
    const cur = await compte("curateur");
    const { id } = await livreAvecFolios(cur, 1);
    expect((await supprimer(cur.headers, id)).status).toBe(403);
    expect(await ligne(id)).not.toBeNull();
  });

  test("un motif est obligatoire", async () => {
    const cur = await compte("curateur");
    const mod = await compte("moderateur");
    const { id } = await livreAvecFolios(cur, 1);
    const r = await app.request(url(id), {
      method: "DELETE", headers: mod.headers, body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
    expect(await ligne(id)).not.toBeNull();
  });

  test("L'EMPREINTE CESSE D'ÊTRE SERVIE AVANT QUE LA BOUCLE L'AIT ATTEINTE", async () => {
    /**
     * C'est l'essai qui justifie l'étape 0.
     *
     * Sans elle, sur le cas qui motive une suppression — un ayant droit écrit au
     * sujet d'un volume PUBLIÉ — `publiable` resterait vrai pendant toute la
     * boucle : deux allers-retours par folio, soit des minutes durant lesquelles
     * chaque empreinte pas encore atteinte continue de sortir.
     *
     * On rend le dépôt injoignable : la boucle échoue sur le PREMIER objet,
     * aucun des suivants n'est touché, et pourtant plus aucun ne doit sortir.
     */
    const cur = await compte("curateur");
    const mod = await compte("moderateur");
    const { id, empreintes } = await livreAvecFolios(cur, 3);

    // Avant : le livre est publié, ses images sortent.
    for (const e of empreintes) {
      expect((await app.request(`/v1/objets/${e}`)).status).toBe(200);
    }

    const r = await sansDepot(() => supprimer(mod.headers, id));
    expect(r.status).toBe(500);

    // La boucle n'a détruit aucun objet — la panne portait sur le premier.
    for (const e of empreintes) expect(await objetExiste(e)).toBe(true);
    // Et pourtant AUCUN ne sort : l'étape 0 a fermé le livre, validée seule,
    // avant le moindre appel au seau.
    for (const e of empreintes) {
      expect((await app.request(`/v1/objets/${e}`)).status).toBe(404);
    }

    const l = await ligne(id);
    expect(l?.publiable).toBe(false);
    expect(l?.retireLe).not.toBeNull();
    expect(l?.statutModeration).toBe("refuse");
  });

  test("le rejeu termine ce qu'une panne a laissé en plan", async () => {
    const cur = await compte("curateur");
    const mod = await compte("moderateur");
    const { id, empreintes } = await livreAvecFolios(cur, 3);

    // Le dépôt injoignable : la boucle échoue sur le premier objet.
    expect((await sansDepot(() => supprimer(mod.headers, id))).status).toBe(500);
    // Le livre est resté — fermé, mais présent. C'est ce qui rend le rejeu
    // possible : rien n'a été détruit à moitié sans que la base le sache.
    expect(await ligne(id)).not.toBeNull();

    // Le dépôt revenu, le second appel termine le travail.
    const r = await supprimer(mod.headers, id);
    expect(r.status).toBe(200);
    expect(await ligne(id)).toBeNull();
    for (const e of empreintes) expect(await objetExiste(e)).toBe(false);

    // Et le registre ne compte qu'UNE disparition, malgré les deux appels.
    const [n] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from livres_supprimes where livre_id = ${id}`,
    );
    expect(n?.n).toBe(1);
  });

  test("un objet partagé avec un autre livre SURVIT", async () => {
    // L'adressage par contenu déduplique : deux ouvrages qui portent la même
    // page de garde partagent l'objet. Détruire les octets de l'un emporterait
    // la page de l'autre, et personne ne le verrait avant qu'une tuile ne manque.
    const cur = await compte("curateur");
    const mod = await compte("moderateur");
    const { corps: a } = await deposerLivre(cur.headers, { publiable: true });
    const { corps: b } = await deposerLivre(cur.headers, { publiable: true });

    const partagee = png(20260806);
    const { corps: o } = await verser(cur.octets, partagee);
    const propre = await verser(cur.octets, png());

    for (const [livre, sha] of [
      [a.id, o.sha256!], [a.id, propre.corps.sha256!], [b.id, o.sha256!],
    ] as const) {
      await app.request(url(livre, "/pages"), {
        method: "POST",
        headers: cur.headers,
        body: JSON.stringify({ folio: sha === o.sha256 ? 1 : 2, imageSha256: sha }),
      });
    }

    const r = await supprimer(mod.headers, a.id);
    expect(r.status).toBe(200);
    expect((await r.json() as { objetsDetruits: number }).objetsDetruits).toBe(1);
    // L'objet partagé est resté, et le livre B le sert toujours.
    expect(await objetExiste(o.sha256!)).toBe(true);
    expect(await objetExiste(propre.corps.sha256!)).toBe(false);
    expect((await app.request(`/v1/objets/${o.sha256}`)).status).toBe(200);
  });

  test("la vignette part avec l'image — les DEUX colonnes sont relevées", async () => {
    // L'empreinte d'une vignette n'apparaît jamais dans `image_sha256` :
    // l'oublier laisserait dans le seau la moitié des octets d'un livre supprimé.
    const cur = await compte("curateur");
    const mod = await compte("moderateur");
    const { corps: l } = await deposerLivre(cur.headers, { publiable: true });
    const image = await verser(cur.octets, png());
    const vignette = await verser(cur.octets, png());
    await app.request(url(l.id, "/pages"), {
      method: "POST",
      headers: cur.headers,
      body: JSON.stringify({
        folio: 1,
        imageSha256: image.corps.sha256,
        vignetteSha256: vignette.corps.sha256,
      }),
    });

    const r = await supprimer(mod.headers, l.id);
    expect((await r.json() as { objetsDetruits: number }).objetsDetruits).toBe(2);
    expect(await objetExiste(vignette.corps.sha256!)).toBe(false);
  });
});

describe("le gardien du dépôt expire", () => {
  test("un objet versé à l'instant sort ; le même, vieux de trois jours, ne sort plus", async () => {
    /**
     * Le gardien `depot` était justifié par « la relecture du contributeur avant
     * de rattacher sa photo à un folio » — un besoin de quelques minutes. Il
     * rendait servable À JAMAIS tout objet versé, y compris les images d'un lot
     * dont le rattachement a échoué : plus aucune page ne les référence, donc
     * aucun gardien ne les refuse, et le balayage de purge ne les voit pas non
     * plus puisqu'il filtre sur `meta.source`, que seul le script de versement
     * écrit. Un dépôt ouvert accumulait des octets publics que rien ne pouvait
     * fermer.
     */
    const c = await compte();
    const { corps } = await verser(c.octets, png());
    const sha = corps.sha256!;
    // Rattaché à aucune page : seul le gardien `depot` le réclame.
    expect((await app.request(`/v1/objets/${sha}`)).status).toBe(200);

    await db.execute(sql`
      update objets set created_at = now() - (${FENETRE_DEPOT_HEURES + 24} || ' hours')::interval
       where sha256 = ${sha}
    `);
    expect((await app.request(`/v1/objets/${sha}`)).status).toBe(404);
  });

  test("une fois la page créée, la bibliothèque prend le relais sans limite de temps", async () => {
    // Le parcours nominal ne dépend pas de la fenêtre : c'est ce qui permet de
    // la fermer sans rien casser.
    const cur = await compte("curateur");
    const { corps: l } = await deposerLivre(cur.headers, { publiable: true });
    const { corps } = await verser(cur.octets, png());
    await app.request(url(l.id, "/pages"), {
      method: "POST",
      headers: cur.headers,
      body: JSON.stringify({ folio: 1, imageSha256: corps.sha256 }),
    });

    await db.execute(sql`
      update objets set created_at = now() - interval '400 days' where sha256 = ${corps.sha256}
    `);
    expect((await app.request(`/v1/objets/${corps.sha256}`)).status).toBe(200);
  });
});
