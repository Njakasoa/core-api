DROP INDEX IF EXISTS "ocr_jobs_page_moteur_uq";--> statement-breakpoint
ALTER TABLE "livres" ADD COLUMN "annee_fin" integer;--> statement-breakpoint
ALTER TABLE "page_ocr" ADD COLUMN "meta" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "vignette_sha256" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ocr_jobs_actif_uq" ON "ocr_jobs" USING btree ("page_id","moteur") WHERE "ocr_jobs"."status" in ('pending', 'running');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pages_vignette_idx" ON "pages" USING btree ("vignette_sha256");--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- Ce que Drizzle ne sait pas générer, et qui n'est pas décoratif.
-- Même geste qu'en 0005 : la règle est écrite dans la base, pas dans un
-- contrôle applicatif à un `db.update()` distrait de sa disparition.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Une passe d'océrisation ne s'efface pas — MAIS un retrait exigé par un
--    ayant droit doit rester possible.
--
--    Un déclencheur qui lève toujours rendrait `DELETE FROM livres` impossible,
--    or `statut_fixation = 'SOUS_DROITS_A_ETABLIR'` existe précisément pour les
--    livres qu'il faudra peut-être retirer. `pg_trigger_depth() = 1` distingue
--    la suppression DIRECTE d'une cascade : une cascade d'intégrité
--    référentielle s'exécute dans un déclencheur interne, donc à une profondeur
--    supérieure. Le comportement est verrouillé par deux tests, pas supposé.
CREATE OR REPLACE FUNCTION page_ocr_no_delete() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION
      'page_ocr est append-only : une passe ne s''efface pas (ocr %). Supprimez la page ou le livre.',
      OLD.id;
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS page_ocr_no_delete ON "page_ocr";--> statement-breakpoint
CREATE TRIGGER page_ocr_no_delete
  BEFORE DELETE ON "page_ocr"
  FOR EACH ROW EXECUTE FUNCTION page_ocr_no_delete();--> statement-breakpoint

-- 2. Les quatre états de la file, dits par la base.
--    Le commentaire du schéma les énumère depuis toujours ; rien ne les
--    imposait. Un `status` mal orthographié produit un travail qu'aucune
--    requête ne réclame et qu'aucune ne clôt.
ALTER TABLE "ocr_jobs" DROP CONSTRAINT IF EXISTS "ocr_jobs_status_ck";--> statement-breakpoint
ALTER TABLE "ocr_jobs" ADD CONSTRAINT "ocr_jobs_status_ck"
  CHECK (status IN ('pending', 'running', 'success', 'failed'));