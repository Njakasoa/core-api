/**
 * Ce qu'on accepte de recevoir, et pourquoi si peu.
 *
 * Une route de téléversement ouverte est la surface la plus exposée d'une API :
 * elle transforme un inconnu en écrivain sur notre stockage. Trois contrôles la
 * tiennent, et chacun couvre ce que les autres laissent passer.
 */

/**
 * LE TYPE EST LU DANS LES OCTETS, JAMAIS DANS L'EN-TÊTE.
 *
 * `Content-Type` est écrit par le client. Le croire, c'est laisser quelqu'un
 * déposer un fichier HTML annoncé `image/jpeg` — que l'API renverra ensuite avec
 * ce même type, mais qu'un navigateur peut être amené à interpréter. Le
 * reniflage par nombre magique est ce qui fait que le type stocké est une
 * observation et non une déclaration.
 *
 * La liste est courte exprès. Elle couvre ce qu'un appareil photo, un scanner ou
 * un téléphone produisent réellement. Élargir se fait en ajoutant une signature
 * ici, pas en desserrant un contrôle ailleurs.
 */
const SIGNATURES: { mime: string; octets: number[]; decalage?: number; suite?: { decalage: number; texte: string } }[] = [
  { mime: "image/jpeg", octets: [0xff, 0xd8, 0xff] },
  { mime: "image/png", octets: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // WebP : « RIFF » puis, quatre octets de taille plus loin, « WEBP ».
  { mime: "image/webp", octets: [0x52, 0x49, 0x46, 0x46], suite: { decalage: 8, texte: "WEBP" } },
  // HEIC/HEIF — ce que produit un iPhone par défaut. La marque est en position 4.
  { mime: "image/heic", octets: [0x66, 0x74, 0x79, 0x70], decalage: 4, suite: { decalage: 8, texte: "heic" } },
  { mime: "image/heif", octets: [0x66, 0x74, 0x79, 0x70], decalage: 4, suite: { decalage: 8, texte: "mif1" } },
  { mime: "image/tiff", octets: [0x49, 0x49, 0x2a, 0x00] }, // petit-boutiste
  { mime: "image/tiff", octets: [0x4d, 0x4d, 0x00, 0x2a] }, // grand-boutiste
];

/** Le type réel des octets, ou `null` si ce n'est aucune image reconnue. */
export function typeReel(octets: Uint8Array): string | null {
  for (const s of SIGNATURES) {
    const d = s.decalage ?? 0;
    if (octets.length < d + s.octets.length) continue;
    if (!s.octets.every((o, i) => octets[d + i] === o)) continue;
    if (s.suite) {
      const attendu = s.suite.texte;
      if (octets.length < s.suite.decalage + attendu.length) continue;
      // Comparaison octet à octet plutôt que par décodage : ces marques sont de
      // l'ASCII pur, et un décodeur ajouterait une dépendance à l'encodage là où
      // il n'y en a pas.
      const ok = [...attendu].every(
        (ch, i) => octets[s.suite!.decalage + i] === ch.charCodeAt(0),
      );
      if (!ok) continue;
    }
    return s.mime;
  }
  return null;
}

/**
 * LE PLAFOND PAR FICHIER.
 *
 * Mesuré sur ce qu'on possède : les scans Gallica à 1400 px font 130 ko à
 * 810 ko. Un téléphone récent produit 3 à 6 Mo, un scanner à plat en TIFF non
 * compressé bien davantage. 20 Mio laisse passer la photo d'un cahier prise au
 * téléphone sans laisser passer un TIFF de plusieurs centaines de mégaoctets.
 *
 * Ce plafond ne remplace pas le `bodyLimit` global : il le double, parce que le
 * global protège la mémoire du processus et celui-ci protège le stockage.
 */
export const TAILLE_MAX_OCTETS = 20 * 1024 * 1024;

/**
 * LE QUOTA PAR COMPTE, SUR UNE FENÊTRE GLISSANTE.
 *
 * Le plafond par fichier ne dit rien de mille fichiers. Sans quota, un compte
 * créé en trois secondes est un robinet d'écriture illimité sur notre stockage,
 * facturé à Cloudflare et impossible à distinguer d'un contributeur zélé.
 *
 * 300 Mio par jour laisse déposer un cahier entier — soixante photos de 5 Mo —
 * et arrête ce qui n'y ressemble pas. La fenêtre GLISSE plutôt que de se
 * réinitialiser à minuit : un plafond calendaire se contourne en attendant le
 * changement de jour, et double le débit à cheval sur deux dates.
 */
export const QUOTA_QUOTIDIEN_OCTETS = 300 * 1024 * 1024;
export const FENETRE_QUOTA_HEURES = 24;

/**
 * Ce qu'on répond quand ce n'est pas une image.
 *
 * Le message nomme ce qui a été observé plutôt que ce qui manquait : « ces
 * octets ne sont pas une image reconnue » se corrige, « type invalide » laisse
 * chercher.
 */
export function refusDeType(declare: string | null): string {
  return (
    `ces octets ne sont pas une image reconnue` +
    (declare ? ` — l'en-tête annonçait ${declare}, mais le contenu dit autre chose` : "") +
    `. Formats acceptés : JPEG, PNG, WebP, HEIC/HEIF, TIFF.`
  );
}
