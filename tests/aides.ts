import { deflateSync } from "node:zlib";
import { createApp } from "../src/app.ts";
import { db } from "../src/db/index.ts";
import { corpusRoles } from "../src/db/schema.ts";
import { id } from "../src/lib/ids.ts";

/**
 * Les témoins partagés par les essais du dépôt et de la bibliothèque.
 *
 * POURQUOI UN MODULE ET PAS UN IMPORT ENTRE FICHIERS D'ESSAI
 * `tests/livre-modification.test.ts` a besoin exactement des mêmes aides que
 * `tests/depot-ouvert.test.ts` : un compte avec un rôle, un vrai PNG, un
 * versement, un dépôt de livre. Importer l'un depuis l'autre ferait ré-enregistrer
 * tous ses `test()` dans le fichier appelant, qui les exécuterait une seconde
 * fois. Un fichier sans `test()` est le seul endroit d'où l'on peut partager.
 *
 * `.ts` et non `.test.ts` : le nom décide si le lanceur le prend pour une suite.
 */
export const app = createApp();

let n = 0;

/** Un compte réel, éventuellement porteur d'un rôle de corpus. */
export async function compte(role?: string) {
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
export function png(graine = Math.floor(Math.random() * 1e9)): Uint8Array {
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

export async function verser(h: { authorization: string }, octets: Uint8Array) {
  const r = await app.request("/v1/objets", {
    method: "POST",
    headers: h,
    body: octets,
  });
  return { statut: r.status, corps: (await r.json()) as { sha256?: string } };
}

export async function deposerLivre(h: Record<string, string>, patch: object = {}) {
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
  return {
    statut: r.status,
    corps: (await r.json()) as { id: string; statutModeration?: string },
  };
}
