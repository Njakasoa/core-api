/**
 * CE QUI EST POSÉ AVANT QUE `src/env.ts` NE SOIT LU.
 *
 * LE DÉFAUT QUE CE FICHIER EMPÊCHE, ET QUI S'EST PRODUIT
 * `bun test` charge le `.env` du projet. Sur une machine où le développement se
 * fait contre le vrai seau — `OBJETS_STOCKAGE=r2` et des identifiants
 * Cloudflare valides, ce qui est le cas normal après la migration — chaque
 * exécution de la suite VERSAIT SES PNG DE TÉMOIN DANS LE SEAU DE PRODUCTION.
 * Rien ne le disait : les essais passaient, l'API répondait 201, et les octets
 * partaient sur le réseau.
 *
 * Ça ne s'est pas vu longtemps parce que ça se voyait mal : l'intégration
 * continue, elle, n'a pas d'identifiants R2, donc `OBJETS_STOCKAGE` y vaut « db »
 * par défaut et tout est vert. Le défaut était strictement local — la pire
 * forme, puisque la barrière qui aurait dû l'attraper était du bon côté.
 *
 * Le repli sur `db` est le bon : il exerce le même code, la même table, les
 * mêmes contraintes, et il n'écrit nulle part hors de la base d'essai. Les
 * essais qui doivent VRAIMENT parler à un stockage d'objet montent un faux seau
 * local et échangent `env` le temps de leur bloc — voir
 * `tests/livre-modification.test.ts` et `tests/stockage.test.ts`.
 */
process.env.OBJETS_STOCKAGE = "db";

// Les identifiants ne servent plus à rien une fois le stockage forcé, et les
// laisser rendrait `depotObjetConfigure()` vrai : un essai qui construirait un
// client S3 le construirait vers la production.
delete process.env.R2_ACCESS_KEY_ID;
delete process.env.R2_SECRET_ACCESS_KEY;
delete process.env.R2_BUCKET;
delete process.env.R2_ENDPOINT;
delete process.env.R2_ACCOUNT_ID;
