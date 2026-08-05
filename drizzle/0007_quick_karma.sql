CREATE TABLE IF NOT EXISTS "page_correction_avis" (
	"id" text PRIMARY KEY NOT NULL,
	"correction_id" text NOT NULL,
	"relecteur_user_id" text NOT NULL,
	"avis" text NOT NULL,
	"motif" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "page_corrections" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"base_ocr_id" text NOT NULL,
	"debut" integer NOT NULL,
	"fin" integer NOT NULL,
	"lu" text NOT NULL,
	"propose" text NOT NULL,
	"motif" text,
	"bbox" jsonb,
	"propose_par_user_id" text NOT NULL,
	"statut" text DEFAULT 'proposee' NOT NULL,
	"revocation" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_correction_avis" ADD CONSTRAINT "page_correction_avis_correction_id_page_corrections_id_fk" FOREIGN KEY ("correction_id") REFERENCES "public"."page_corrections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_correction_avis" ADD CONSTRAINT "page_correction_avis_relecteur_user_id_users_id_fk" FOREIGN KEY ("relecteur_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_corrections" ADD CONSTRAINT "page_corrections_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_corrections" ADD CONSTRAINT "page_corrections_base_ocr_id_page_ocr_id_fk" FOREIGN KEY ("base_ocr_id") REFERENCES "public"."page_ocr"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_corrections" ADD CONSTRAINT "page_corrections_propose_par_user_id_users_id_fk" FOREIGN KEY ("propose_par_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "page_correction_avis_uq" ON "page_correction_avis" USING btree ("correction_id","relecteur_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_correction_avis_relecteur_idx" ON "page_correction_avis" USING btree ("relecteur_user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_corrections_file_idx" ON "page_corrections" USING btree ("statut","page_id","debut");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_corrections_base_idx" ON "page_corrections" USING btree ("base_ocr_id","debut");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_corrections_auteur_idx" ON "page_corrections" USING btree ("propose_par_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "page_corrections_doublon_uq" ON "page_corrections" USING btree ("base_ocr_id","debut","fin","propose_par_user_id") WHERE statut = 'proposee';--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- Ce que Drizzle ne sait pas générer. Même geste qu'en 0005 et 0006 : la règle
-- vit dans la base, pas dans un contrôle applicatif à un `db.update()` distrait
-- de sa disparition. Ici c'est plus vrai qu'ailleurs — n'importe qui connecté
-- peut proposer, donc ces règles sont sur le chemin d'inconnus.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

-- ── 1. La reprise : 353 lectures qui n'existent que dans une colonne mutable ─
--
-- `scripts/seed-bibliotheque.ts` fait `onConflictDoUpdate({ set: { texteOcr } })`.
-- Rejouer le versement après une nouvelle océrisation réécrit `pages.texte_ocr`
-- SUR PLACE. Un offset enregistré dedans deviendrait faux en silence. `page_ocr`
-- est immuable par déclencheur : un offset y reste valide pour toujours.
--
-- L'identité de la passe est PARTIELLE, et c'est la vérité disponible.
-- `fetch_gallica.py` supprimait l'image qu'il venait de lire (`tmp.unlink()`) et
-- n'enregistrait aucune version de tesseract. Les octets aujourd'hui en base ont
-- été retéléchargés plus tard, même URL IIIF et même largeur, sans qu'on ait
-- vérifié qu'ils sont identiques. Écrire ici l'empreinte et la version
-- d'aujourd'hui ferait passer une supposition pour une mesure — dans le champ
-- dont la docstring dit qu'il existe pour empêcher exactement cela.
INSERT INTO page_ocr (id, page_id, moteur, texte, texte_sha256, meta, created_at)
SELECT 'ocr_' || encode(sha256((p.id || ':reprise')::bytea), 'hex'),
       p.id,
       coalesce(p.ocr_moteur, 'tesseract-fra'),
       p.texte_ocr,
       encode(sha256(convert_to(p.texte_ocr, 'UTF8')), 'hex'),
       jsonb_build_object(
         'origine', 'reprise de pages.texte_ocr',
         'produit_par', 'repparcs/scripts/fetch_gallica.py',
         'commande', 'tesseract <image> -l fra --psm 3',
         'largeur_image_demandee', 1400,
         'version_tesseract', NULL,
         'image_sha256', NULL,
         'note', 'Identité PARTIELLE, et c''est la vérité disponible : le script '
              || 'd''origine a supprimé l''image lue et n''a pas enregistré sa '
              || 'version de tesseract. Les octets en base ont été retéléchargés '
              || 'ensuite, sans vérification d''identité.',
         'created_at_signifie', 'la date du versement, pas celle de la lecture'),
       p.created_at
  FROM pages p
 WHERE p.texte_ocr IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM page_ocr o WHERE o.page_id = p.id);--> statement-breakpoint

-- ── 2. Ce qui se vérifie sans lire la passe ─────────────────────────────────
ALTER TABLE "page_corrections" ADD CONSTRAINT "page_corrections_statut_ck"
  CHECK (statut IN ('proposee','acceptee','refusee','retiree','obsolete','revoquee'));--> statement-breakpoint

-- Intervalle demi-ouvert, JAMAIS vide : un int4range vide ne chevauche rien,
-- donc deux insertions acceptées au même point passeraient la contrainte
-- d'exclusion et s'appliqueraient dans un ordre indéterminé.
ALTER TABLE "page_corrections" ADD CONSTRAINT "page_corrections_intervalle_ck"
  CHECK (debut >= 0 AND fin > debut);--> statement-breakpoint

-- LE CANARI UNICODE. `char_length` compte des points de code, `String.length`
-- des unités UTF-16. Mesuré sur les 1 782 pages du corpus : aucun caractère hors
-- BMP, tout en NFC — les deux coïncident AUJOURD'HUI. C'est une mesure, pas une
-- garantie. Le jour où une passe émet autre chose, ceci lève au lieu
-- d'enregistrer un offset silencieusement décalé.
ALTER TABLE "page_corrections" ADD CONSTRAINT "page_corrections_lu_longueur_ck"
  CHECK (char_length(lu) = fin - debut);--> statement-breakpoint

-- Une correction qui ne change rien n'est pas une correction.
ALTER TABLE "page_corrections" ADD CONSTRAINT "page_corrections_change_ck"
  CHECK (propose <> lu);--> statement-breakpoint

-- Plafonds d'étendue. 400 caractères ≈ une longue phrase ; au-delà on ne corrige
-- plus un passage, on réécrit la page sous un autre nom. `propose` VIDE reste
-- permis : c'est une suppression, la correction la plus fréquente ici.
ALTER TABLE "page_corrections" ADD CONSTRAINT "page_corrections_etendue_ck"
  CHECK (fin - debut <= 400 AND char_length(propose) <= 2 * (fin - debut) + 200);--> statement-breakpoint

ALTER TABLE "page_corrections" ADD CONSTRAINT "page_corrections_propose_lisible_ck"
  CHECK (translate(propose, E'\t\n', '  ') !~ '[[:cntrl:]]');--> statement-breakpoint

ALTER TABLE "page_corrections" ADD CONSTRAINT "page_corrections_revocation_ck"
  CHECK ((statut = 'revoquee') = (revocation IS NOT NULL));--> statement-breakpoint

ALTER TABLE "page_correction_avis" ADD CONSTRAINT "page_correction_avis_valeur_ck"
  CHECK (avis IN ('accord','desaccord'));--> statement-breakpoint

-- ── 3. Deux corrections ACCEPTÉES ne se chevauchent jamais ──────────────────
--    Proposer sur un passage déjà proposé reste PERMIS : deux lecteurs qui
--    signalent le même mot est un signal, et arbitrer entre deux lectures est
--    exactement le métier du relecteur. Refuser la seconde jetterait peut-être
--    la bonne. Ce qu'on interdit, c'est deux ACCEPTATIONS concurrentes, qui
--    rendraient le texte dérivé dépendant de l'ordre d'application.
ALTER TABLE "page_corrections"
  ADD CONSTRAINT "page_corrections_accepte_sans_chevauchement_ex"
  EXCLUDE USING gist (base_ocr_id WITH =, int4range(debut, fin) WITH &&)
  WHERE (statut = 'acceptee');--> statement-breakpoint

-- ── 4. L'ANCRAGE. La règle la plus utile du lot. ────────────────────────────
--    Elle transforme « l'écart est détectable » en « l'écart est inécrivable ».
--    Et c'est le SEUL endroit où se fait la conversion entre les offsets
--    0-indexés demi-ouverts de l'API et le `substr` 1-indexé de Postgres.
CREATE OR REPLACE FUNCTION page_correction_ancree() RETURNS trigger AS $$
DECLARE base_page text; base_texte text; porte text;
BEGIN
  SELECT o.page_id, o.texte INTO base_page, base_texte
    FROM page_ocr o WHERE o.id = NEW.base_ocr_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'correction : la lecture de base % n''existe pas', NEW.base_ocr_id;
  END IF;
  IF base_page <> NEW.page_id THEN
    RAISE EXCEPTION
      'correction : la lecture % porte sur la page %, pas sur la page %',
      NEW.base_ocr_id, base_page, NEW.page_id;
  END IF;
  IF NEW.fin > char_length(base_texte) THEN
    RAISE EXCEPTION
      'correction : l''intervalle [%, %) déborde une lecture de % caractères',
      NEW.debut, NEW.fin, char_length(base_texte);
  END IF;
  porte := substr(base_texte, NEW.debut + 1, NEW.fin - NEW.debut);
  IF porte <> NEW.lu THEN
    RAISE EXCEPTION
      'correction : entre % et % la lecture porte « % », la proposition dit avoir lu « % »',
      NEW.debut, NEW.fin, porte, NEW.lu;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS page_corrections_ancree ON "page_corrections";--> statement-breakpoint
CREATE TRIGGER page_corrections_ancree
  BEFORE INSERT ON "page_corrections"
  FOR EACH ROW EXECUTE FUNCTION page_correction_ancree();--> statement-breakpoint

-- ── 5. Une proposition ne se réécrit pas ; seule sa décision s'inscrit ──────
--    `page_ocr` est immuable par déclencheur, mais le texte AFFICHÉ dépend
--    désormais de cette table-ci. Sans ce mur, un `UPDATE page_corrections SET
--    propose = …` sur une ligne acceptée réécrirait ce que le public lit, sans
--    nouvelle ligne, sans trace et sans empreinte : la muraille serait bâtie
--    autour de la mauvaise table.
CREATE OR REPLACE FUNCTION page_correction_immuable() RETURNS trigger AS $$
BEGIN
  IF (NEW.page_id, NEW.base_ocr_id, NEW.debut, NEW.fin, NEW.lu, NEW.propose,
      NEW.motif, NEW.bbox, NEW.propose_par_user_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.page_id, OLD.base_ocr_id, OLD.debut, OLD.fin, OLD.lu, OLD.propose,
      OLD.motif, OLD.bbox, OLD.propose_par_user_id, OLD.created_at) THEN
    RAISE EXCEPTION
      'correction % : le contenu d''une proposition ne se réécrit pas ; seule sa décision s''inscrit',
      OLD.id;
  END IF;
  IF NEW.statut IS DISTINCT FROM OLD.statut
     AND NOT (
       (OLD.statut = 'proposee'
          AND NEW.statut IN ('acceptee','refusee','retiree','obsolete'))
       -- La SORTIE d'une acceptation erronée. Sans elle, un intervalle accepté
       -- à tort est verrouillé à vie : la ligne est immuable et la contrainte
       -- d'exclusion interdit toute rivale.
       OR (OLD.statut = 'acceptee' AND NEW.statut = 'revoquee')
     ) THEN
    RAISE EXCEPTION 'correction % : transition % → % interdite',
      OLD.id, OLD.statut, NEW.statut;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS page_corrections_immuable ON "page_corrections";--> statement-breakpoint
CREATE TRIGGER page_corrections_immuable
  BEFORE UPDATE ON "page_corrections"
  FOR EACH ROW EXECUTE FUNCTION page_correction_immuable();--> statement-breakpoint

-- ── 6. Plafonds ────────────────────────────────────────────────────────────
--    N'importe qui connecté peut proposer, et 120 requêtes par minute font
--    172 800 propositions par jour sur un corpus de 353 pages. 60 par page :
--    la page médiane fait ~2 000 caractères, soit ~330 mots. Au-delà d'une
--    correction tous les cinq mots, on ne corrige plus, on transcrit.
CREATE OR REPLACE FUNCTION page_correction_plafond() RETURNS trigger AS $$
DECLARE n_page int; n_total int;
BEGIN
  SELECT count(*) INTO n_page FROM page_corrections
   WHERE propose_par_user_id = NEW.propose_par_user_id
     AND page_id = NEW.page_id AND statut = 'proposee';
  IF n_page >= 60 THEN
    RAISE EXCEPTION
      'plafond : 60 propositions déjà en attente sur cette page. Attendez une relecture.';
  END IF;
  SELECT count(*) INTO n_total FROM page_corrections
   WHERE propose_par_user_id = NEW.propose_par_user_id AND statut = 'proposee';
  IF n_total >= 300 THEN
    RAISE EXCEPTION
      'plafond : 300 propositions déjà en attente. Attendez une relecture.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS page_corrections_plafond ON "page_corrections";--> statement-breakpoint
CREATE TRIGGER page_corrections_plafond
  BEFORE INSERT ON "page_corrections"
  FOR EACH ROW EXECUTE FUNCTION page_correction_plafond();--> statement-breakpoint

-- ── 7. Un avis, et le seuil qui en fait une décision ───────────────────────
--    On ne juge pas sa propre proposition, et la règle est en base plutôt que
--    dans un `if` qu'un remaniement déplace.
CREATE OR REPLACE FUNCTION page_correction_avis_recevable() RETURNS trigger AS $$
DECLARE auteur text; st text;
BEGIN
  SELECT propose_par_user_id, statut INTO auteur, st
    FROM page_corrections WHERE id = NEW.correction_id;
  IF auteur = NEW.relecteur_user_id THEN
    RAISE EXCEPTION 'on ne relit pas sa propre proposition';
  END IF;
  IF st <> 'proposee' THEN
    RAISE EXCEPTION 'cette proposition est déjà « % » : il n''y a plus à en juger', st;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS page_correction_avis_recevable ON "page_correction_avis";--> statement-breakpoint
CREATE TRIGGER page_correction_avis_recevable
  BEFORE INSERT ON "page_correction_avis"
  FOR EACH ROW EXECUTE FUNCTION page_correction_avis_recevable();--> statement-breakpoint

-- Un avis ne se réécrit pas : changer d'avis, c'est révoquer, pas raturer.
CREATE OR REPLACE FUNCTION page_correction_avis_immuable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'un avis de relecture ne se réécrit pas (avis %)', OLD.id;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS page_correction_avis_immuable ON "page_correction_avis";--> statement-breakpoint
CREATE TRIGGER page_correction_avis_immuable
  BEFORE UPDATE ON "page_correction_avis"
  FOR EACH ROW EXECUTE FUNCTION page_correction_avis_immuable();--> statement-breakpoint

-- LE SEUIL. Un seul accord suffit AUJOURD'HUI. Le porter à deux relecteurs de
-- régions différentes — ce que repparcs/scripts/kit_relecture.py exige déjà hors
-- ligne — est un changement de cette constante, pas du schéma : c'est pour ça
-- que les avis sont une table et non deux colonnes.
--
-- Les avis ne sont JAMAIS moyennés. Un désaccord suffit à refuser, un accord à
-- accepter, et les deux lignes restent lisibles côte à côte.
CREATE OR REPLACE FUNCTION page_correction_statut() RETURNS trigger AS $$
DECLARE accords_requis constant int := 1;
        refus_requis   constant int := 1;
        n_accord int; n_desaccord int;
BEGIN
  SELECT count(*) FILTER (WHERE avis = 'accord'),
         count(*) FILTER (WHERE avis = 'desaccord')
    INTO n_accord, n_desaccord
    FROM page_correction_avis WHERE correction_id = NEW.correction_id;

  IF n_desaccord >= refus_requis THEN
    UPDATE page_corrections SET statut = 'refusee'
     WHERE id = NEW.correction_id AND statut = 'proposee';
  ELSIF n_accord >= accords_requis THEN
    UPDATE page_corrections SET statut = 'acceptee'
     WHERE id = NEW.correction_id AND statut = 'proposee';
    -- Les propositions rivales sur le même passage deviennent sans objet. On
    -- les marque plutôt que de les laisser encombrer la file d'un relecteur
    -- qui ne pourra de toute façon plus les accepter.
    UPDATE page_corrections r
       SET statut = 'obsolete'
      FROM page_corrections a
     WHERE a.id = NEW.correction_id
       AND r.base_ocr_id = a.base_ocr_id
       AND r.id <> a.id
       AND r.statut = 'proposee'
       AND int4range(r.debut, r.fin) && int4range(a.debut, a.fin);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS page_correction_statut ON "page_correction_avis";--> statement-breakpoint
CREATE TRIGGER page_correction_statut
  AFTER INSERT ON "page_correction_avis"
  FOR EACH ROW EXECUTE FUNCTION page_correction_statut();
