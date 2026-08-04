ALTER TABLE "tale_consents" ALTER COLUMN "licence_accordee" DROP DEFAULT;--> statement-breakpoint
-- ── Un consentement ne se modifie pas. Il se supprime, ou il est remplacé. ──
--
-- Le schéma déclarait `tale_consents` append-only — « un consentement modifiable
-- n'est pas une preuve » — mais seule `tale_versions` avait son déclencheur. Un
-- seul UPDATE, script de maintenance ou endpoint futur, basculait `clonage_vocal`
-- ou `diffusion_publique_texte` sans laisser de trace. C'est le raisonnement déjà
-- tenu pour le texte brut, appliqué au document qui engage une personne réelle.
--
-- BEFORE UPDATE SEULEMENT, et c'est délibéré. Bloquer aussi le DELETE entrerait
-- en collision frontale avec les engagements du projet : un consentement se
-- retire, et le dépôt s'est engagé par écrit à supprimer des données sur refus.
-- Une révision passe par une nouvelle ligne pointant l'ancienne (supersedes_id
-- existe déjà) ; un retrait passe par une suppression, qui reste possible.
CREATE OR REPLACE FUNCTION tale_consent_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'tale_consents is append-only: supersede it, or delete it (consent %)',
    OLD.id;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS tale_consents_no_update ON "tale_consents";
--> statement-breakpoint
CREATE TRIGGER tale_consents_no_update
  BEFORE UPDATE ON "tale_consents"
  FOR EACH ROW EXECUTE FUNCTION tale_consent_immutable();
