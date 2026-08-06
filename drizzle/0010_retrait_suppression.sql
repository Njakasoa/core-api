-- Retirer un livre, et le supprimer — deux gestes différents, deux états différents.
--
-- CE QUE CETTE MIGRATION RÉPARE AVANT MÊME D'AJOUTER QUOI QUE CE SOIT
-- Jusqu'ici, « ce livre a été retiré » et « ce livre n'a jamais eu le droit
-- d'être publié » s'écrivaient dans les mêmes colonnes : `publiable = false` et
-- `motif_non_publiable` rempli. Or c'est exactement la signature d'un dépôt
-- déclaré sous droits par son propre déposant, à la seconde où il arrive.
--
-- La conséquence n'est pas théorique : un rétablissement aveugle aurait publié
-- une œuvre que personne n'avait jamais eu le droit de publier — il aurait suffi
-- de remettre `publiable = true` sur un livre qui ne l'avait jamais été. Le
-- retrait a donc ses propres colonnes, et `motif_non_publiable` n'est plus jamais
-- réécrit : c'est la déclaration du déposant, pas une décision de retrait.

-- QUAND, PAR QUI, POURQUOI. Les trois questions d'un retrait contesté.
ALTER TABLE "livres" ADD COLUMN IF NOT EXISTS "retire_le" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "livres" ADD COLUMN IF NOT EXISTS "retire_par_user_id" text
  REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "livres" ADD COLUMN IF NOT EXISTS "motif_retrait" text;--> statement-breakpoint

-- CE QU'IL FAUT REMETTRE, ET SURTOUT PAS « true ».
-- Sans cette colonne, rétablir voudrait dire publier — y compris un livre qui
-- n'était pas publiable avant qu'on le retire. Elle garde l'état d'origine pour
-- que le rétablissement soit une ANNULATION et non une décision de publier.
ALTER TABLE "livres" ADD COLUMN IF NOT EXISTS "publiable_avant" boolean;--> statement-breakpoint

-- UN RETRAIT DOIT DIRE POURQUOI, comme un refus de modération.
-- Un livre disparu sans motif est un livre que son déposant ne peut ni
-- comprendre ni contester.
ALTER TABLE "livres" DROP CONSTRAINT IF EXISTS "livres_retrait_motive_ck";--> statement-breakpoint
ALTER TABLE "livres" ADD CONSTRAINT "livres_retrait_motive_ck"
  CHECK (retire_le IS NULL
         OR (motif_retrait IS NOT NULL AND length(btrim(motif_retrait)) > 0));--> statement-breakpoint

-- Les quatre colonnes vont ensemble ou pas du tout. Un `retire_par_user_id`
-- posé sans `retire_le` ferait un livre retiré que rien ne dit retiré.
ALTER TABLE "livres" DROP CONSTRAINT IF EXISTS "livres_retrait_complet_ck";--> statement-breakpoint
ALTER TABLE "livres" ADD CONSTRAINT "livres_retrait_complet_ck"
  CHECK ((retire_le IS NULL) = (publiable_avant IS NULL));--> statement-breakpoint

-- UN LIVRE RETIRÉ N'EST PAS PUBLIABLE. C'est la définition, et la base la tient :
-- une route qui poserait `retire_le` en oubliant `publiable = false` laisserait
-- les octets sortir alors que l'écran annonce un retrait.
ALTER TABLE "livres" DROP CONSTRAINT IF EXISTS "livres_retire_non_publiable_ck";--> statement-breakpoint
ALTER TABLE "livres" ADD CONSTRAINT "livres_retire_non_publiable_ck"
  CHECK (retire_le IS NULL OR publiable = false);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "livres_retrait_idx" ON "livres" ("retire_le");--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- CE QUI RESTE D'UN LIVRE SUPPRIMÉ : DE QUOI RÉPONDRE, RIEN DE PLUS.
--
-- Une suppression définitive détruit les octets et, par cascade, les pages, les
-- océrisations, les corrections proposées par des tiers et les avis rendus
-- dessus. Ne rien garder du tout rendrait la question « pourquoi ce livre
-- a-t-il disparu ? » sans réponse — y compris pour le déposant, qui la posera
-- en premier, et pour l'ayant droit qui a demandé le retrait et voudra savoir
-- qu'il a été fait.
--
-- AUCUN CONTENU N'EST CONSERVÉ. Ni texte, ni image, ni empreinte : garder les
-- empreintes permettrait de vérifier qu'un fichier reversé est bien celui qu'on
-- a fait retirer, mais ce serait garder une trace de ce qu'un ayant droit a
-- demandé d'effacer. Le titre et la source suffisent à répondre.
CREATE TABLE IF NOT EXISTS "livres_supprimes" (
  "id" text PRIMARY KEY,
  -- L'identifiant du livre disparu. PAS une clé étrangère : la ligne qu'elle
  -- désignerait n'existe plus, c'est tout l'objet de cette table.
  "livre_id" text NOT NULL,
  "titre" text NOT NULL,
  "auteur" text,
  "annee" integer,
  "source" text NOT NULL,
  "source_ref" text NOT NULL,
  -- À qui parler. `on delete set null` : la suppression d'un compte ne doit pas
  -- emporter la trace de la décision.
  "depose_par_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "supprime_par_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "motif" text NOT NULL,
  -- Combien d'octets ont RÉELLEMENT été détruits, et combien de pages sont
  -- parties avec. Un décompte à zéro sur un livre de 374 folios est le signe
  -- que la boucle n'a pas fait son travail — sans ces chiffres, plus rien après
  -- coup ne permettrait de s'en apercevoir.
  "objets_detruits" integer NOT NULL DEFAULT 0,
  "pages_supprimees" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

-- Une suppression rejouée ne s'inscrit qu'une fois. La route est rejouable par
-- construction — un échec R2 à mi-course se reprend — et sans cette unicité le
-- registre compterait deux disparitions là où il n'y en a eu qu'une.
CREATE UNIQUE INDEX IF NOT EXISTS "livres_supprimes_livre_uq" ON "livres_supprimes" ("livre_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "livres_supprimes_deposant_idx" ON "livres_supprimes" ("depose_par_user_id", "created_at");
