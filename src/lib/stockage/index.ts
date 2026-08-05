/**
 * Le stockage d'objets — ce que le reste du code importe.
 *
 *   cles.ts     la règle de nommage, fixée une fois pour toutes
 *   depots.ts   où vivent les octets : Postgres ou un stockage compatible S3
 *   objets.ts   la table, le registre de gardiens, et la règle qui autorise
 *
 * Une fonctionnalité qui stocke des fichiers a trois choses à faire, et pas une
 * de plus :
 *
 *   1. verser              await ecrireObjet(octets, mime, "original")
 *   2. garder l'empreinte  dans SA table, comme elle garde n'importe quel champ
 *   3. dire qui peut voir  enregistrerGardien({ nom, verdict })
 *
 * Elle n'a ni route d'octets à écrire, ni cache à poser, ni limiteur à régler :
 * `GET /v1/objets/:sha256` sert déjà tout le dépôt, et la règle d'autorisation
 * interroge son gardien avec ceux des autres.
 */
export { CLASSES, cle, empreinteValide, prefixeClasse, type Classe } from "./cles.ts";
export {
  depotObjetConfigure,
  depotParDefaut,
  depotR2,
  oublierClientDepot,
  type Depot,
  type NomDepot,
} from "./depots.ts";
export {
  ecrireObjet,
  enregistrerGardien,
  ficheObjet,
  lireObjet,
  objetServable,
  oublierGardiens,
  supprimerObjet,
  type Gardien,
  type Objet,
  type Verdict,
} from "./objets.ts";
