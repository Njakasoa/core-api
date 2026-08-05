-- Le téléversement s'ouvre aux contributeurs, donc la modération devient obligatoire.
--
-- Jusqu'ici seuls les curateurs versaient, et par script : ce que contenait la
-- bibliothèque était su d'avance. Ouvrir le dépôt à quiconque photographie un
-- cahier est ce qui peut réellement débloquer les ~400 angano manquants, et
-- c'est aussi la porte par laquelle du contenu sous droits entre sans qu'on le
-- sache. La file de modération est le prix de cette ouverture, pas une option.

-- QUI A DÉPOSÉ. Nul pour les six volumes Gallica, versés avant que quiconque
-- puisse déposer. Sans cette colonne, un retrait à la demande du déposant est
-- impossible : on ne saurait pas quoi retirer.
ALTER TABLE "livres" ADD COLUMN IF NOT EXISTS "depose_par_user_id" text
  REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "objets" ADD COLUMN IF NOT EXISTS "depose_par_user_id" text
  REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint

-- L'ÉTAT DE LA MODÉRATION, SÉPARÉ DES DROITS.
-- `publiable` dit « avons-nous le droit », celle-ci dit « quelqu'un a-t-il
-- vérifié ». Les confondre ferait disparaître la question qu'on ne pose pas :
-- un ouvrage peut être libre de droits et n'avoir été relu par personne — c'est
-- l'état de tout dépôt de contributeur à la seconde où il arrive.
ALTER TABLE "livres" ADD COLUMN IF NOT EXISTS "statut_moderation" text NOT NULL DEFAULT 'en_attente';--> statement-breakpoint
ALTER TABLE "livres" ADD COLUMN IF NOT EXISTS "motif_moderation" text;--> statement-breakpoint
ALTER TABLE "livres" ADD COLUMN IF NOT EXISTS "modere_par_user_id" text
  REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "livres" ADD COLUMN IF NOT EXISTS "modere_le" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "livres" DROP CONSTRAINT IF EXISTS "livres_statut_moderation_ck";--> statement-breakpoint
ALTER TABLE "livres" ADD CONSTRAINT "livres_statut_moderation_ck"
  CHECK (statut_moderation IN ('en_attente', 'accepte', 'refuse'));--> statement-breakpoint

-- UN REFUS SANS MOTIF EST UN REFUS QU'ON NE PEUT PAS CORRIGER.
-- Le déposant doit pouvoir savoir quoi refaire ; sans motif, il ne peut que
-- redéposer à l'identique.
ALTER TABLE "livres" DROP CONSTRAINT IF EXISTS "livres_refus_motive_ck";--> statement-breakpoint
ALTER TABLE "livres" ADD CONSTRAINT "livres_refus_motive_ck"
  CHECK (statut_moderation <> 'refuse' OR (motif_moderation IS NOT NULL AND length(btrim(motif_moderation)) > 0));--> statement-breakpoint

-- Les livres DÉJÀ EN BASE ont été versés par un curateur, sur des notices dont
-- les droits ont été relevés un par un. Les laisser en attente les ferait
-- disparaître de la liste publique le jour du déploiement — une régression
-- muette causée par un défaut de colonne.
UPDATE "livres" SET statut_moderation = 'accepte' WHERE depose_par_user_id IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "livres_moderation_idx" ON "livres" ("statut_moderation", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "livres_depose_par_idx" ON "livres" ("depose_par_user_id");--> statement-breakpoint
-- Le quota de téléversement se calcule par cet index : somme des octets d'un
-- compte sur une fenêtre glissante. Sans lui, chaque dépôt balaie la table.
CREATE INDEX IF NOT EXISTS "objets_deposant_idx" ON "objets" ("depose_par_user_id", "created_at");
