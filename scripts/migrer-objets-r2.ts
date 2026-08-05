/**
 * Déménage les octets stockés de Postgres vers Cloudflare R2, ligne par ligne.
 *
 * POURQUOI PAS UN BASCULEMENT D'UN COUP
 * Parce qu'à mi-chemin il faut que le site marche encore. Chaque ligne de
 * `objets` porte sa colonne `stockage`, la route la lit, et une base à moitié
 * migrée sert donc chaque image depuis l'endroit où elle est réellement. Le
 * script peut être interrompu, relancé, ou arrêté définitivement en cours de
 * route : aucun de ces trois cas ne casse quoi que ce soit.
 *
 * L'ORDRE EST CELUI-CI ET IL N'EST PAS INTERCHANGEABLE
 *   1. écrire l'objet dans le seau
 *   2. LE RELIRE et vérifier que son empreinte est bien la sienne
 *   3. seulement alors, effacer `contenu` et poser `stockage = 'r2'`
 * Effacer avant d'avoir relu, ce serait faire confiance à une écriture qu'on n'a
 * pas vérifiée pour détruire la seule copie qui reste. La relecture n'est pas de
 * la prudence rituelle : elle est ce qui distingue « déménagé » de « perdu », et
 * c'est le seul moment où la différence est encore rattrapable.
 *
 *     bun scripts/migrer-objets-r2.ts --essai      # ne modifie rien
 *     bun scripts/migrer-objets-r2.ts              # déménage
 *     bun scripts/migrer-objets-r2.ts --verifier   # relit tout, ne modifie rien
 *     bun scripts/migrer-objets-r2.ts --retour     # ramène R2 → base
 *
 * Il tourne LÀ OÙ EST LA BASE, comme seed-bibliotheque.ts : en production le
 * `DATABASE_URL` n'est joignable que depuis le réseau Docker.
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db/index.ts";
import { sha256Bytes } from "../src/lib/crypto.ts";
import { depotObjetConfigure, depotR2 } from "../src/lib/stockage/index.ts";
import type { Classe } from "../src/lib/stockage/index.ts";

const ESSAI = process.argv.includes("--essai");
const VERIFIER = process.argv.includes("--verifier");
const RETOUR = process.argv.includes("--retour");

if (!depotObjetConfigure()) {
  console.error(
    "R2 n'est pas configuré. Il faut R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,\n" +
      "R2_SECRET_ACCESS_KEY et R2_BUCKET dans l'environnement de ce script.",
  );
  process.exit(1);
}

const [etat] = await db.execute<{ db: number; r2: number; octets_db: number }>(sql`
  select count(*) filter (where stockage = 'db')::int as db,
         count(*) filter (where stockage = 'r2')::int as r2,
         coalesce(sum(octets) filter (where stockage = 'db'), 0)::bigint as octets_db
    from objets
`);
console.log(
  `état : ${etat?.db ?? 0} en base (${((Number(etat?.octets_db ?? 0)) / 1e6).toFixed(0)} Mo) · ` +
    `${etat?.r2 ?? 0} dans R2`,
);

/**
 * Relit chaque objet déjà déménagé et vérifie qu'il redonne son empreinte.
 *
 * Ne modifie rien. C'est le contrôle qu'on lance AVANT de supprimer quoi que ce
 * soit d'autre, et celui qu'on relance six mois plus tard pour savoir si le seau
 * contient encore ce qu'on croit y avoir mis.
 */
if (VERIFIER) {
  const lignes = await db.execute<{ sha256: string; classe: Classe; octets: number }>(sql`
    select sha256, classe, octets from objets where stockage = 'r2' order by sha256
  `);
  let bonnes = 0;
  const manquantes: string[] = [];
  const alterees: string[] = [];
  for (const l of lignes) {
    const octets = await depotR2.lire(l.classe, l.sha256);
    if (!octets) manquantes.push(l.sha256);
    else if (sha256Bytes(octets) !== l.sha256) alterees.push(l.sha256);
    else bonnes++;
  }
  console.log(`\n${bonnes}/${lignes.length} objets relus et conformes`);
  if (manquantes.length > 0) {
    console.error(`${manquantes.length} ABSENTS du seau : ${manquantes.slice(0, 5).join(", ")}…`);
  }
  if (alterees.length > 0) {
    console.error(`${alterees.length} ALTÉRÉS : ${alterees.slice(0, 5).join(", ")}…`);
  }
  // Un objet absent ou altéré est une tuile blanche en ligne : il faut que le
  // shell le sache, pour qu'un cron ne le rate pas.
  process.exit(manquantes.length + alterees.length > 0 ? 1 : 0);
}

/**
 * Le retour en arrière, et il n'est pas symétrique du déménagement.
 *
 * Il ramène les octets dans `contenu` et repose `stockage = 'db'`, mais NE
 * SUPPRIME PAS l'objet du seau. Un retour se fait généralement dans l'urgence,
 * souvent parce qu'on doute du seau ; détruire au passage la copie dont on
 * doute, c'est se priver du moyen de comprendre. Le balayage des orphelines de
 * seed-bibliotheque.ts est là pour nettoyer plus tard, à froid.
 */
if (RETOUR) {
  const lignes = await db.execute<{ sha256: string; classe: Classe }>(sql`
    select sha256, classe from objets where stockage = 'r2' order by sha256
  `);
  let faites = 0;
  for (const l of lignes) {
    const octets = await depotR2.lire(l.classe, l.sha256);
    if (!octets) {
      console.error(`  ✗ ${l.sha256.slice(0, 12)}… absent du seau — ligne laissée en 'r2'`);
      continue;
    }
    if (sha256Bytes(octets) !== l.sha256) {
      console.error(`  ✗ ${l.sha256.slice(0, 12)}… altéré dans le seau — ligne laissée en 'r2'`);
      continue;
    }
    if (ESSAI) {
      faites++;
      continue;
    }
    await db.execute(sql`
      update objets set contenu = ${octets}, stockage = 'db' where sha256 = ${l.sha256}
    `);
    faites++;
  }
  console.log(`\n${faites}/${lignes.length} objet(s) ramenée(s) en base${ESSAI ? " [essai]" : ""}`);
  console.log("les objets restent dans le seau : purgez-les à froid, une fois le doute levé");
  process.exit(0);
}

const aFaire = await db.execute<{ sha256: string; mime: string; classe: Classe; contenu: Uint8Array }>(sql`
  select sha256, mime, classe, contenu from objets where stockage = 'db' order by sha256
`);

let deplacees = 0;
let octetsDeplaces = 0;
const echecs: { sha256: string; motif: string }[] = [];

for (const img of aFaire) {
  // L'empreinte de la ligne est vérifiée AVANT d'écrire quoi que ce soit. Si les
  // octets en base ne redonnent pas déjà leur nom, le déménagement propagerait
  // une corruption dans le seau en la faisant passer pour un déplacement propre.
  const vrai = sha256Bytes(img.contenu);
  if (vrai !== img.sha256) {
    echecs.push({ sha256: img.sha256, motif: `octets en base valant ${vrai.slice(0, 12)}…` });
    continue;
  }

  if (ESSAI) {
    deplacees++;
    octetsDeplaces += img.contenu.byteLength;
    continue;
  }

  try {
    await depotR2.ecrire(img.classe, img.sha256, img.contenu, img.mime);
    const relus = await depotR2.lire(img.classe, img.sha256);
    if (!relus || sha256Bytes(relus) !== img.sha256) {
      echecs.push({ sha256: img.sha256, motif: "relecture du seau non conforme" });
      continue;
    }
    // Les octets ne sont effacés de la base qu'ICI, après avoir été relus. La
    // contrainte `objets_stockage_ck` rend l'état intermédiaire impossible : les
    // deux colonnes changent dans la même instruction ou aucune ne change.
    await db.execute(sql`
      update objets set contenu = null, stockage = 'r2' where sha256 = ${img.sha256}
    `);
    deplacees++;
    octetsDeplaces += img.contenu.byteLength;
    if (deplacees % 50 === 0) console.log(`  … ${deplacees}/${aFaire.length}`);
  } catch (e) {
    echecs.push({ sha256: img.sha256, motif: String((e as Error).message ?? e) });
  }
}

console.log(
  `\n${deplacees}/${aFaire.length} objet(s) déménagée(s) ` +
    `(${(octetsDeplaces / 1e6).toFixed(0)} Mo)${ESSAI ? " [essai — rien écrit]" : ""}`,
);
for (const e of echecs.slice(0, 10)) {
  console.error(`  ✗ ${e.sha256.slice(0, 12)}… ${e.motif}`);
}
if (echecs.length > 0) {
  console.error(`${echecs.length} échec(s) — ces lignes gardent leurs octets en base et restent servies`);
}

// La base ne rend pas son espace toute seule : `contenu = null` laisse les pages
// mortes derrière lui. Il faut le dire, sinon « la base a maigri » est faux et
// personne ne comprend pourquoi le disque n'a pas bougé.
if (!ESSAI && deplacees > 0) {
  console.log(
    `\nl'espace n'est pas rendu tant que la table n'a pas été compactée :\n` +
      `  psql "$DATABASE_URL" -c 'VACUUM FULL objets'   (prend un verrou exclusif)\n` +
      `  ou laissez l'autovacuum le réutiliser progressivement, sans verrou`,
  );
}

process.exit(echecs.length > 0 ? 1 : 0);
