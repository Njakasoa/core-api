import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { sql } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { db } from "../src/db/index.ts";
import { corpusRoles } from "../src/db/schema.ts";
import { id } from "../src/lib/ids.ts";
import { sha256Bytes } from "../src/lib/crypto.ts";
import { typeReel, TAILLE_MAX_OCTETS } from "../src/lib/stockage/images-entrantes.ts";

/**
 * Le dépôt ouvert aux contributeurs — et ce qui le rend tenable.
 *
 * `routes/bibliotheque.ts` écrivait qu'aucune route d'écriture d'octets
 * n'existerait, parce qu'« une plateforme où n'importe qui téléverse une page de
 * livre est une plateforme qui republie du contenu sous droits sans le savoir ».
 * Cette phrase reste vraie. Ce que ces tests vérifient, c'est ce qu'on a mis en
 * face — et chacun d'eux porte sur une chose dont l'absence ne se verrait pas :
 *
 *   un livre déposé n'apparaît dans AUCUNE liste avant d'avoir été jugé
 *   un livre REFUSÉ cesse de servir ses images
 *   le type est lu dans les octets, jamais dans l'en-tête que le client écrit
 *   personne ne peut ajouter de page au livre d'autrui
 *
 * Ce sont des tests d'ABSENCE pour la moitié d'entre eux, la classe de défaut la
 * plus silencieuse : rien n'échoue quand une API se met à servir trop.
 */
const app = createApp();

let n = 0;
async function compte(role?: string) {
  const email = `dep${Date.now()}_${n++}@core.test`;
  const r = await app.request("/v1/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery" }),
  });
  const { user, accessToken } = (await r.json()) as {
    user: { id: string };
    accessToken: string;
  };
  if (role) {
    await db.insert(corpusRoles).values({
      id: id("crole"),
      userId: user.id,
      role,
      grantedByUserId: user.id,
    });
  }
  return {
    id: user.id,
    email,
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    octets: { authorization: `Bearer ${accessToken}` },
  };
}

/** Un vrai PNG, unique à chaque appel — l'adressage par contenu déduplique, et
 *  des octets figés donneraient le même objet à tous les tests. */
function png(graine = Math.floor(Math.random() * 1e9)): Uint8Array {
  const n = 8;
  const bloc = (type: string, data: Uint8Array) => {
    const t = new TextEncoder().encode(type);
    const corps = new Uint8Array([...t, ...data]);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, data.length);
    // Le CRC n'est pas vérifié par notre reniflage (qui ne lit que la signature),
    // mais un PNG invalide serait un mauvais témoin : on l'écrit correctement.
    const crc = new Uint8Array(4);
    new DataView(crc.buffer).setUint32(0, crc32(corps));
    return new Uint8Array([...len, ...corps, ...crc]);
  };
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, n); v.setUint32(4, n); ihdr[8] = 8; ihdr[9] = 2;
  // UN GÉNÉRATEUR, ET PAS `(x * 7 + graine + y) % 256`.
  // Cette formule-là réduisait un milliard de graines à 256 images distinctes :
  // le modulo écrasait toute l'entropie de la graine. Deux comptes finissaient
  // par déposer exactement les mêmes octets, `on conflict do nothing` gardait le
  // premier déposant, et le test de quota échouait une fois sur trois — un
  // échec intermittent dont la cause était dans le témoin, pas dans le code.
  let etat = graine >>> 0;
  const suivant = () => ((etat = (etat * 1_664_525 + 1_013_904_223) >>> 0) >>> 24);
  const brut: number[] = [];
  for (let y = 0; y < n; y++) {
    brut.push(0);
    for (let x = 0; x < n * 3; x++) brut.push(suivant());
  }
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...bloc("IHDR", ihdr),
    ...bloc("IDAT", new Uint8Array(deflateSync(Buffer.from(brut)))),
    ...bloc("IEND", new Uint8Array()),
  ]);
}

function crc32(d: Uint8Array): number {
  let c = ~0;
  for (const o of d) {
    c ^= o;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

async function verser(h: { authorization: string }, octets: Uint8Array) {
  const r = await app.request("/v1/objets", {
    method: "POST",
    headers: h,
    body: octets,
  });
  return { statut: r.status, corps: (await r.json()) as { sha256?: string } };
}

async function deposerLivre(h: Record<string, string>, patch: object = {}) {
  const r = await app.request("/v1/bibliotheque/livres", {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      sourceRef: `cahier-${Date.now()}-${n++}`,
      source: "scan_local",
      titre: "Cahier déposé",
      statutFixation: "SOUS_DROITS_A_ETABLIR",
      licence: "recherche non commerciale",
      publiable: true,
      ...patch,
    }),
  });
  return { statut: r.status, corps: (await r.json()) as { id: string; statutModeration?: string } };
}

describe("le type est OBSERVÉ, pas déclaré", () => {
  test("un HTML annoncé image/jpeg est refusé", async () => {
    // Le croire laisserait déposer une page HTML que l'API rendrait ensuite avec
    // ce même type — et qu'un navigateur peut être amené à interpréter.
    const c = await compte();
    const html = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
    const r = await app.request("/v1/objets", {
      method: "POST",
      headers: { ...c.octets, "content-type": "image/jpeg" },
      body: html,
    });
    expect(r.status).toBe(422);
  });

  test("les signatures reconnues le sont, et rien d'autre", () => {
    expect(typeReel(png())).toBe("image/png");
    expect(typeReel(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(typeReel(new Uint8Array([0x49, 0x49, 0x2a, 0x00]))).toBe("image/tiff");
    // Un « RIFF » sans « WEBP » n'est pas une image : un WAV commence pareil.
    expect(typeReel(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]))).toBeNull();
    expect(typeReel(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull(); // PDF
    expect(typeReel(new Uint8Array())).toBeNull();
  });

  test("un anonyme ne peut rien verser", async () => {
    const r = await app.request("/v1/objets", { method: "POST", body: png() });
    expect(r.status).toBe(401);
  });

  test("le corps vide est refusé avant tout le reste", async () => {
    const c = await compte();
    const r = await app.request("/v1/objets", { method: "POST", headers: c.octets });
    expect(r.status).toBe(400);
  });
});

describe("ce qui est versé est relisible, et c'est bien lui", () => {
  test("l'empreinte rendue est celle des octets, et l'objet sort aussitôt", async () => {
    const c = await compte();
    const octets = png();
    const { statut, corps } = await verser(c.octets, octets);
    expect(statut).toBe(201);
    // Recalculée plutôt que crue : l'empreinte EST l'adresse.
    expect(corps.sha256).toBe(sha256Bytes(octets));

    // Servi sans jeton : une balise <img> n'en porte pas. Le gardien « depot »
    // le réclame parce qu'il a un déposant — sans quoi le contributeur ne
    // pourrait pas se relire avant de rattacher sa photo à un folio.
    const r = await app.request(`/v1/objets/${corps.sha256}`);
    expect(r.status).toBe(200);
    expect(sha256Bytes(new Uint8Array(await r.arrayBuffer()))).toBe(corps.sha256!);
  });

  test("redéposer les mêmes octets rend la même empreinte", async () => {
    const c = await compte();
    const octets = png(42);
    const a = await verser(c.octets, octets);
    const b = await verser(c.octets, octets);
    expect(b.corps.sha256).toBe(a.corps.sha256);
    expect(b.statut).toBe(201);
  });

  test("deux comptes qui versent les mêmes octets partagent l'objet, et le premier en reste le déposant", async () => {
    // CE COMPORTEMENT EST UNE CONSÉQUENCE DE L'ADRESSAGE PAR CONTENU, pas un
    // choix qu'on aurait pu faire autrement sans tout changer : les mêmes octets
    // ont le même nom, donc un seul objet existe. Deux personnes photographiant
    // le même ouvrage imprimé tombent dessus.
    //
    // Ce que ça implique, et qui n'est PAS résolu ici : le second n'est pas
    // enregistré comme déposant, donc son quota n'est pas débité — logique,
    // rien de neuf n'est stocké — mais surtout, un retrait demandé par le
    // PREMIER emporterait l'image du livre du second. Le jour où cela se
    // produira, il faudra une table de déposants et non une colonne.
    // Graine TIRÉE AU SORT, et non fixée : la base d'essai persiste entre les
    // exécutions, donc une graine constante trouve l'objet déjà versé par le
    // passage précédent — et le « premier déposant » est alors un compte d'hier.
    const octets = png();
    const a = await compte();
    const b = await compte();
    const ra = await verser(a.octets, octets);
    const rb = await verser(b.octets, octets);
    expect(rb.corps.sha256).toBe(ra.corps.sha256);

    const [ligne] = await db.execute<{ deposant: string }>(sql`
      select depose_par_user_id as deposant from objets where sha256 = ${ra.corps.sha256!}
    `);
    expect(ligne!.deposant).toBe(a.id);
  });

  test("le quota est compté par déposant, et le plafond par fichier est dit", async () => {
    // On ne verse pas 300 Mio dans un test : ce qui est vérifiable ici est que la
    // comptabilité existe et qu'elle attribue les octets au bon compte.
    const c = await compte();
    const octets = png();
    await verser(c.octets, octets);
    const [r] = await db.execute<{ total: string }>(sql`
      select coalesce(sum(octets),0)::bigint as total from objets where depose_par_user_id = ${c.id}
    `);
    expect(Number(r!.total)).toBeGreaterThanOrEqual(octets.byteLength);
    expect(TAILLE_MAX_OCTETS).toBeGreaterThan(5 * 1024 * 1024); // la photo d'un téléphone passe
  });
});

describe("un dépôt n'est pas une publication", () => {
  test("le livre d'un contributeur naît en attente et n'est listé nulle part", async () => {
    const c = await compte();
    const { corps } = await deposerLivre(c.headers);
    expect(corps.statutModeration).toBe("en_attente");

    // Le public ne le trouve ni par son identifiant…
    expect((await app.request(`/v1/bibliotheque/livres/${corps.id}`)).status).toBe(404);
    // …ni dans la liste. C'est le test le plus facile à casser sans le voir : il
    // suffirait d'oublier une condition dans le WHERE.
    const liste = await app.request("/v1/bibliotheque/livres?limit=100");
    const { data } = (await liste.json()) as { data: { id: string }[] };
    expect(data.some((l) => l.id === corps.id)).toBe(false);
  });

  test("son déposant le voit, et sait pourquoi il n'est pas public", async () => {
    const c = await compte();
    const { corps } = await deposerLivre(c.headers);
    const r = await app.request(`/v1/bibliotheque/livres/${corps.id}`, { headers: c.headers });
    expect(r.status).toBe(200);
    const b = (await r.json()) as { statutModeration: string; deposeParMoi: boolean };
    expect(b.statutModeration).toBe("en_attente");
    expect(b.deposeParMoi).toBe(true);
  });

  test("un autre compte connecté ne le voit pas non plus", async () => {
    // 404 et non 403 : un 403 confirmerait l'identifiant à qui le devine.
    const c = await compte();
    const tiers = await compte();
    const { corps } = await deposerLivre(c.headers);
    const r = await app.request(`/v1/bibliotheque/livres/${corps.id}`, { headers: tiers.headers });
    expect(r.status).toBe(404);
  });

  test("le livre d'un curateur est accepté d'emblée", async () => {
    // Son travail EST la vérification ; lui demander de se modérer lui-même
    // n'ajouterait qu'une file qu'il viderait seul.
    const cur = await compte("curateur");
    const { corps } = await deposerLivre(cur.headers);
    expect(corps.statutModeration).toBe("accepte");
    expect((await app.request(`/v1/bibliotheque/livres/${corps.id}`)).status).toBe(200);
  });
});

describe("les folios appartiennent à leur déposant", () => {
  test("le déposant rattache une image déjà versée", async () => {
    const c = await compte();
    const { corps: livre } = await deposerLivre(c.headers);
    const { corps: objet } = await verser(c.octets, png());
    const r = await app.request(`/v1/bibliotheque/livres/${livre.id}/pages`, {
      method: "POST",
      headers: c.headers,
      body: JSON.stringify({ folio: 1, imageSha256: objet.sha256 }),
    });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { imageUrl: string }).imageUrl).toBe(`/v1/objets/${objet.sha256}`);
  });

  test("une empreinte qu'aucun objet ne porte est refusée", async () => {
    // Sinon la page pointerait vers une tuile blanche que rien ne signale.
    const c = await compte();
    const { corps: livre } = await deposerLivre(c.headers);
    const r = await app.request(`/v1/bibliotheque/livres/${livre.id}/pages`, {
      method: "POST",
      headers: c.headers,
      // Une empreinte TIRÉE AU SORT, pas `"a".repeat(64)` : cette valeur-là est
      // déjà versée par tests/bibliotheque.test.ts, et le test passait alors pour
      // une raison qui n'était pas la sienne.
      body: JSON.stringify({ folio: 1, imageSha256: sha256Bytes(png()) }),
    });
    expect(r.status).toBe(422);
  });

  test("un tiers ne peut pas ajouter de page au livre d'autrui", async () => {
    const c = await compte();
    const intrus = await compte();
    const { corps: livre } = await deposerLivre(c.headers);
    const r = await app.request(`/v1/bibliotheque/livres/${livre.id}/pages`, {
      method: "POST",
      headers: intrus.headers,
      body: JSON.stringify({ folio: 1 }),
    });
    expect(r.status).toBe(403);
  });
});

describe("la modération décide, et sa décision porte sur les octets", () => {
  test("la file est fermée à qui n'a pas le rôle", async () => {
    const c = await compte();
    expect((await app.request("/v1/bibliotheque/moderation", { headers: c.headers })).status).toBe(403);
  });

  test("un refus sans motif est rejeté", async () => {
    // Sans motif, le déposant ne peut que redéposer à l'identique.
    const mod = await compte("moderateur");
    const c = await compte();
    const { corps: livre } = await deposerLivre(c.headers);
    const r = await app.request(`/v1/bibliotheque/livres/${livre.id}/moderation`, {
      method: "POST",
      headers: mod.headers,
      body: JSON.stringify({ decision: "refuse" }),
    });
    expect(r.status).toBe(422);
  });

  test("un livre refusé cesse de servir ses images", async () => {
    // LE TEST QUI COMPTE. Les octets sont bien présents dans le dépôt ; c'est le
    // vote des gardiens qui les retient, et lui seul.
    const mod = await compte("moderateur");
    const c = await compte();
    const { corps: livre } = await deposerLivre(c.headers);
    const { corps: objet } = await verser(c.octets, png());
    await app.request(`/v1/bibliotheque/livres/${livre.id}/pages`, {
      method: "POST", headers: c.headers,
      body: JSON.stringify({ folio: 1, imageSha256: objet.sha256 }),
    });
    expect((await app.request(`/v1/objets/${objet.sha256}`)).status).toBe(200);

    await app.request(`/v1/bibliotheque/livres/${livre.id}/moderation`, {
      method: "POST", headers: mod.headers,
      body: JSON.stringify({ decision: "refuse", motif: "ouvrage imprimé sous droits" }),
    });
    expect((await app.request(`/v1/objets/${objet.sha256}`)).status).toBe(404);

    // Et accepter le rouvre : la décision se corrige.
    await app.request(`/v1/bibliotheque/livres/${livre.id}/moderation`, {
      method: "POST", headers: mod.headers,
      body: JSON.stringify({ decision: "accepte" }),
    });
    expect((await app.request(`/v1/objets/${objet.sha256}`)).status).toBe(200);
    expect((await app.request(`/v1/bibliotheque/livres/${livre.id}`)).status).toBe(200);
  });

  test("la décision garde qui l'a prise, quand, et pourquoi", async () => {
    const mod = await compte("moderateur");
    const c = await compte();
    const { corps: livre } = await deposerLivre(c.headers);
    await app.request(`/v1/bibliotheque/livres/${livre.id}/moderation`, {
      method: "POST", headers: mod.headers,
      body: JSON.stringify({ decision: "refuse", motif: "la notice ne dit pas la licence" }),
    });
    const [l] = await db.execute<{ par: string; motif: string; le: string }>(sql`
      select modere_par_user_id as par, motif_moderation as motif, modere_le as le
        from livres where id = ${livre.id}
    `);
    // Le jour où un refus est contesté, « qui a décidé et sur quel motif » est la
    // seule question qui compte.
    expect(l!.par).toBe(mod.id);
    expect(l!.motif).toContain("licence");
    expect(l!.le).not.toBeNull();
  });
});

describe("gérer les accès", () => {
  test("un contributeur ne voit pas la liste des comptes", async () => {
    const c = await compte();
    expect((await app.request("/v1/corpus/utilisateurs", { headers: c.headers })).status).toBe(403);
  });

  test("un modérateur retrouve un compte par son courriel et lui accorde un rôle", async () => {
    // Sans cette route, le premier rôle de qui que ce soit était impossible à
    // accorder autrement que par un INSERT à la main.
    const mod = await compte("moderateur");
    const cible = await compte();
    const r = await app.request(
      `/v1/corpus/utilisateurs?q=${encodeURIComponent(cible.email)}`,
      { headers: mod.headers },
    );
    const { data } = (await r.json()) as { data: { id: string; roles: string[] }[] };
    expect(data).toHaveLength(1);
    expect(data[0]!.id).toBe(cible.id);
    expect(data[0]!.roles).toEqual([]);

    const accord = await app.request("/v1/corpus/roles", {
      method: "POST", headers: mod.headers,
      body: JSON.stringify({ userId: cible.id, role: "relecteur", motif: "essai" }),
    });
    expect(accord.status).toBe(201);

    const moi = await app.request("/v1/corpus/roles/moi", { headers: cible.headers });
    expect(((await moi.json()) as { roles: string[] }).roles).toEqual(["relecteur"]);
  });

  test("mes rôles sont annoncés sans qu'il faille essuyer un 403", async () => {
    const c = await compte();
    const r = await app.request("/v1/corpus/roles/moi", { headers: c.headers });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { roles: string[] }).roles).toEqual([]);
  });
});
