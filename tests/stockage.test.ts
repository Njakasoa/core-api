import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../src/db/index.ts";
import { sha256Bytes } from "../src/lib/crypto.ts";
import { cle, empreinteValide } from "../src/lib/stockage/cles.ts";
import {
  enregistrerGardien,
  objetServable,
  oublierGardiens,
} from "../src/lib/stockage/objets.ts";
import { oublierClientDepot } from "../src/lib/stockage/depots.ts";

/**
 * Le dépôt d'objets — la couche que toute fonctionnalité partagera.
 *
 * Ce qui est éprouvé ici n'est pas « est-ce que ça range des octets », mais les
 * trois choses qui, ratées, ne se voient pas :
 *
 *   1. la RÈGLE DE NOMMAGE, qui ne se renégocie plus une fois des objets versés
 *   2. le VOTE DES GARDIENS, où un seul refus doit l'emporter sur toute permission
 *   3. l'ALLER-RETOUR RÉEL vers un stockage S3, pour ne pas livrer un chemin que
 *      personne n'a jamais exécuté
 *
 * Le troisième point demande un serveur S3 : il est écrit plus bas, en trente
 * lignes. Sauter ce test faute d'identifiants Cloudflare aurait voulu dire que
 * le code R2 n'est vérifié qu'en production, le jour du basculement.
 */

describe("la règle de nommage des objets", () => {
  const h = "a".repeat(64);

  test("la classe, deux niveaux de deux caractères, puis l'empreinte", () => {
    const sha = "3fa9c2" + "0".repeat(58);
    expect(cle("original", sha)).toBe(`original/3f/a9/${sha}`);
    expect(cle("derive", sha)).toBe(`derive/3f/a9/${sha}`);
  });

  test("les deux classes ne peuvent pas se chevaucher", () => {
    // Ce que ça garantit : une règle de cycle de vie posée sur `derive/` ne peut
    // atteindre aucun original. C'est toute la raison d'être des deux classes.
    expect(cle("derive", h).startsWith("derive/")).toBe(true);
    expect(cle("original", h).startsWith("derive/")).toBe(false);
  });

  test("une empreinte mal formée est refusée, pas normalisée", () => {
    // Fabriquer un nom sur une empreinte fausse désigne un objet que personne ne
    // peut produire, et le défaut reste muet jusqu'à ce qu'une tuile manque.
    expect(() => cle("original", "trop-court")).toThrow();
    expect(() => cle("original", "A".repeat(64))).toThrow(); // majuscules
    expect(() => cle("original", "../../etc/passwd")).toThrow();
    expect(empreinteValide(h)).toBe(true);
  });

  test("le nom ne dépend que du contenu, jamais de la fonctionnalité", () => {
    // La propriété qui fait tenir la déduplication : deux fonctionnalités qui
    // manipulent les mêmes octets doivent tomber sur le même objet.
    expect(cle("original", h)).toBe(cle("original", h));
  });
});

describe("le vote des gardiens", () => {
  const h = "b".repeat(64);

  afterAll(() => oublierGardiens());

  test("sans gardien, rien ne sort", async () => {
    oublierGardiens();
    // « aucun ne refuse » ne suffit pas : à vide, tout objet orphelin sortirait.
    // Un ouvrage retiré dont les rattachements ont disparu redeviendrait public
    // par le seul fait qu'on l'a détaché.
    expect((await objetServable(h)).servable).toBe(false);
  });

  test("un seul gardien qui accepte suffit", async () => {
    oublierGardiens();
    enregistrerGardien({ nom: "a", async verdict() { return "servable"; } });
    expect((await objetServable(h)).servable).toBe(true);
  });

  test("un refus l'emporte sur n'importe quelle permission", async () => {
    oublierGardiens();
    enregistrerGardien({ nom: "permissif", async verdict() { return "servable"; } });
    enregistrerGardien({ nom: "strict", async verdict() { return "refusee"; } });
    const v = await objetServable(h);
    // L'adressage par contenu fait que deux fonctionnalités PEUVENT désigner les
    // mêmes octets avec des droits opposés, et rien ne dit alors laquelle des
    // deux étiquettes est fausse. On tranche du côté qui se répare : une tuile
    // blanche, pas un retrait.
    expect(v.servable).toBe(false);
    expect(v.refusePar).toEqual(["strict"]);
  });

  test("« inconnue » n'est pas une permission", async () => {
    oublierGardiens();
    enregistrerGardien({ nom: "muet", async verdict() { return "inconnue"; } });
    expect((await objetServable(h)).servable).toBe(false);
  });

  test("l'ordre d'enregistrement ne change rien", async () => {
    oublierGardiens();
    enregistrerGardien({ nom: "strict", async verdict() { return "refusee"; } });
    enregistrerGardien({ nom: "permissif", async verdict() { return "servable"; } });
    expect((await objetServable(h)).servable).toBe(false);
  });
});

describe("les deux états incohérents sont impossibles en base", () => {
  const octets = new Uint8Array([1, 2, 3, 4]);
  const h = sha256Bytes(octets);

  test("une ligne `db` sans octets est refusée", async () => {
    // Sans la contrainte, ce serait une tuile blanche dont aucun journal ne
    // parle : la ligne existe, la route la trouve, et il n'y a rien à servir.
    // `db.execute()` rend un objet de requête différable, pas une promesse : le
    // passer tel quel à `expect().rejects` fait comparer l'objet lui-même et le
    // test passe pour de mauvaises raisons. D'où la fonction.
    const ecrire = async () => void (await db.execute(sql`
      insert into objets (sha256, mime, octets, classe, contenu, stockage)
      values (${h + ""}, 'image/jpeg', 4, 'original', null, 'db')
    `));
    await expect(ecrire()).rejects.toThrow(/objets_stockage_ck/);
  });

  test("une ligne `r2` qui garde ses octets est refusée", async () => {
    // L'autre moitié, plus sournoise : le déménagement paraît fait, la base n'a
    // pas maigri, et les deux copies peuvent diverger sans que rien ne le dise.
    // `db.execute()` rend un objet de requête différable, pas une promesse : le
    // passer tel quel à `expect().rejects` fait comparer l'objet lui-même et le
    // test passe pour de mauvaises raisons. D'où la fonction.
    const ecrire = async () => void (await db.execute(sql`
      insert into objets (sha256, mime, octets, classe, contenu, stockage)
      values (${"c".repeat(64)}, 'image/jpeg', 4, 'original', ${octets}, 'r2')
    `));
    await expect(ecrire()).rejects.toThrow(/objets_stockage_ck/);
  });

  test("une classe inventée est refusée", async () => {
    // La classe entre dans le NOM de l'objet. Une valeur hors des deux connues
    // produirait un préfixe qu'aucune règle de rétention ne couvre.
    // `db.execute()` rend un objet de requête différable, pas une promesse : le
    // passer tel quel à `expect().rejects` fait comparer l'objet lui-même et le
    // test passe pour de mauvaises raisons. D'où la fonction.
    const ecrire = async () => void (await db.execute(sql`
      insert into objets (sha256, mime, octets, classe, contenu, stockage)
      values (${"d".repeat(64)}, 'image/jpeg', 4, 'vignette', ${octets}, 'db')
    `));
    await expect(ecrire()).rejects.toThrow(/objets_classe_ck/);
  });
});

/**
 * Un stockage compatible S3, en trente lignes, pour éprouver le vrai chemin.
 *
 * Il ne vérifie pas les signatures — ce n'est pas ce qu'on teste ici. Ce qu'on
 * teste, c'est que `Bun.S3Client` configuré comme le fait `depots.ts` écrit et
 * relit bien un objet AU NOM QUE LA RÈGLE PRÉVOIT, et qu'un objet absent rend
 * `null` au lieu de faire remonter une erreur.
 */
describe("l'aller-retour vers un stockage d'objet", () => {
  const seau = "essai";
  const contenus = new Map<string, { octets: Uint8Array; type: string }>();
  let serveur: ReturnType<typeof Bun.serve> | null = null;
  let depot: typeof import("../src/lib/stockage/depots.ts").depotR2 | null = null;

  beforeAll(async () => {
    serveur = Bun.serve({
      port: 0,
      async fetch(req) {
        const chemin = new URL(req.url).pathname.replace(`/${seau}/`, "");
        if (req.method === "PUT") {
          contenus.set(chemin, {
            octets: new Uint8Array(await req.arrayBuffer()),
            type: req.headers.get("content-type") ?? "",
          });
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
        return new Response(o.octets, { headers: { "content-type": o.type } });
      },
    });

    process.env.R2_ACCESS_KEY_ID = "essai";
    process.env.R2_SECRET_ACCESS_KEY = "essai-secret";
    process.env.R2_BUCKET = seau;
    process.env.R2_ENDPOINT = `http://127.0.0.1:${serveur.port}`;
    // `env` a été figé à l'import ; le dépôt lit `env`, donc on le rafraîchit et
    // on jette le client mémorisé.
    const { env } = await import("../src/env.ts");
    Object.assign(env, {
      R2_ACCESS_KEY_ID: "essai",
      R2_SECRET_ACCESS_KEY: "essai-secret",
      R2_BUCKET: seau,
      R2_ENDPOINT: `http://127.0.0.1:${serveur.port}`,
    });
    oublierClientDepot();
    depot = (await import("../src/lib/stockage/depots.ts")).depotR2;
  });

  afterAll(() => {
    serveur?.stop(true);
    oublierClientDepot();
  });

  test("ce qui est écrit se relit à l'identique", async () => {
    const octets = new Uint8Array([0xff, 0xd8, 0x01, 0x02, 0x03, 0xff, 0xd9]);
    const h = sha256Bytes(octets);
    await depot!.ecrire("original", h, octets, "image/jpeg");

    const relus = await depot!.lire("original", h);
    expect(relus).not.toBeNull();
    // Re-hacher plutôt que comparer les tableaux : c'est le contrôle qui a un
    // sens ici, puisque l'empreinte est l'adresse.
    expect(sha256Bytes(relus!)).toBe(h);
  });

  test("l'objet porte le nom que la règle prévoit", async () => {
    const octets = new Uint8Array([9, 8, 7]);
    const h = sha256Bytes(octets);
    await depot!.ecrire("derive", h, octets, "image/webp");
    // C'est CE test qui rend la règle de nommage exécutoire : sans lui, elle
    // resterait une intention écrite dans un commentaire.
    expect([...contenus.keys()]).toContain(cle("derive", h));
    expect(contenus.get(cle("derive", h))!.type).toBe("image/webp");
  });

  test("une classe différente est un objet différent", async () => {
    const octets = new Uint8Array([4, 4, 4]);
    const h = sha256Bytes(octets);
    await depot!.ecrire("original", h, octets, "image/jpeg");
    // Lire au mauvais préfixe ne doit rien trouver — sinon la séparation des
    // deux classes ne tiendrait pas et une purge des dérivés emporterait des
    // originaux.
    expect(await depot!.lire("derive", h)).toBeNull();
    expect(await depot!.lire("original", h)).not.toBeNull();
  });

  test("un objet absent rend null, pas une erreur", async () => {
    expect(await depot!.lire("original", "e".repeat(64))).toBeNull();
  });

  test("supprimer un objet absent ne lève pas", async () => {
    // Le retrait doit pouvoir être rejoué : un ayant droit qui redemande la
    // suppression ne doit pas recevoir une erreur parce que c'est déjà fait.
    await depot!.supprimer("original", "f".repeat(64));
  });

  test("supprimer enlève bien l'objet", async () => {
    const octets = new Uint8Array([5, 5, 5, 5]);
    const h = sha256Bytes(octets);
    await depot!.ecrire("original", h, octets, "image/jpeg");
    await depot!.supprimer("original", h);
    expect(await depot!.lire("original", h)).toBeNull();
  });
});
