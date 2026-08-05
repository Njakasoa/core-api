-- `images` devient `objets` : le dépôt cesse d'appartenir à la bibliothèque.
--
-- La table rangeait des octets adressés par leur empreinte, ce qui n'a jamais
-- rien eu d'une image. La suite du projet en stockera d'autres — photos de
-- cahiers envoyées par les contributeurs, pièces jointes, clips — et chacune
-- aurait redemandé sa table, sa route et son cache. RENAME plutôt que
-- CREATE + INSERT + DROP : les lignes ne bougent pas, donc rien ne peut se
-- perdre en chemin, et un retour en arrière est un second RENAME.
ALTER TABLE IF EXISTS "images" RENAME TO "objets";--> statement-breakpoint
ALTER INDEX IF EXISTS "images_pkey" RENAME TO "objets_pkey";--> statement-breakpoint

-- Où sont les octets de CETTE ligne. Porté par la ligne et non par une variable
-- d'environnement : une base à moitié migrée doit rester servable, chaque objet
-- étant lu là où il est réellement. Un drapeau global aurait rendu 404 tout le
-- reliquat à l'instant du basculement, en silence.
ALTER TABLE "objets" ADD COLUMN IF NOT EXISTS "stockage" text NOT NULL DEFAULT 'db';--> statement-breakpoint

-- `original` ou `derive` — le REMPLAÇABLE, pas le sujet. Un dérivé se régénère à
-- partir d'un original (vignette, transcodage, synthèse) ; un original ne se
-- régénère pas. C'est ce qui permet à une règle de cycle de vie R2 de purger
-- `derive/` sans pouvoir atteindre `original/` par accident.
--
-- Le défaut est `original` : c'est le choix qui ne détruit rien si l'on se
-- trompe, et les lignes déjà en base contiennent surtout des scans.
ALTER TABLE "objets" ADD COLUMN IF NOT EXISTS "classe" text NOT NULL DEFAULT 'original';--> statement-breakpoint
ALTER TABLE "objets" DROP CONSTRAINT IF EXISTS "objets_classe_ck";--> statement-breakpoint
ALTER TABLE "objets" ADD CONSTRAINT "objets_classe_ck" CHECK (classe IN ('original', 'derive'));--> statement-breakpoint

-- Les vignettes déjà versées SONT des dérivés : elles se régénèrent depuis la
-- page. Les reconnaître ici évite de traiter 374 objets régénérables comme du
-- patrimoine irremplaçable dans toutes les règles de rétention à venir.
UPDATE "objets" o SET classe = 'derive'
 WHERE EXISTS (SELECT 1 FROM "pages" p WHERE p.vignette_sha256 = o.sha256)
   AND NOT EXISTS (SELECT 1 FROM "pages" p WHERE p.image_sha256 = o.sha256);--> statement-breakpoint

-- Ce que la fonctionnalité propriétaire sait de l'objet et que le dépôt n'a pas
-- à connaître : dimensions d'une image, durée d'un clip, page d'origine. Les
-- colonnes `largeur`/`hauteur` restaient image-spécifiques dans une table qui ne
-- l'est plus ; elles passent ici sans être perdues.
ALTER TABLE "objets" ADD COLUMN IF NOT EXISTS "meta" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "objets" SET meta = meta
  || CASE WHEN largeur IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('largeur', largeur) END
  || CASE WHEN hauteur IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('hauteur', hauteur) END
 WHERE largeur IS NOT NULL OR hauteur IS NOT NULL;--> statement-breakpoint
ALTER TABLE "objets" DROP COLUMN IF EXISTS "largeur";--> statement-breakpoint
ALTER TABLE "objets" DROP COLUMN IF EXISTS "hauteur";--> statement-breakpoint

-- `contenu` devient nullable : c'est ce qui permet à une ligne migrée de ne plus
-- porter ses octets. La contrainte ci-dessous est ce qui empêche que
-- « nullable » veuille dire « on ne sait pas ».
ALTER TABLE "objets" ALTER COLUMN "contenu" DROP NOT NULL;--> statement-breakpoint

-- Les deux seuls états cohérents. Sans elle, deux pannes muettes deviennent
-- possibles : une ligne `db` sans octets (tuile blanche, aucune trace) et une
-- ligne `r2` qui garde ses octets en base (le déménagement paraît fait, la base
-- n'a pas maigri, et les deux copies peuvent diverger).
ALTER TABLE "objets" DROP CONSTRAINT IF EXISTS "objets_stockage_ck";--> statement-breakpoint
ALTER TABLE "objets" ADD CONSTRAINT "objets_stockage_ck" CHECK (
  (stockage = 'db' AND contenu IS NOT NULL) OR
  (stockage = 'r2' AND contenu IS NULL)
);--> statement-breakpoint

-- Combien de lignes restent à déménager, sans balayer la table entière.
CREATE INDEX IF NOT EXISTS "objets_stockage_idx" ON "objets" ("stockage", "classe");
