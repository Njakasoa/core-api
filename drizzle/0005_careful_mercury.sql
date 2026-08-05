CREATE TABLE IF NOT EXISTS "images" (
	"sha256" text PRIMARY KEY NOT NULL,
	"mime" text NOT NULL,
	"octets" integer NOT NULL,
	"largeur" integer,
	"hauteur" integer,
	"contenu" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "livres" (
	"id" text PRIMARY KEY NOT NULL,
	"source_ref" text NOT NULL,
	"source" text NOT NULL,
	"titre" text NOT NULL,
	"auteur" text,
	"annee" integer,
	"langue" text DEFAULT 'plt_Latn' NOT NULL,
	"pages_total" integer,
	"statut_recit" text DEFAULT 'EXPRESSION_DU_FOLKLORE' NOT NULL,
	"statut_fixation" text NOT NULL,
	"licence" text NOT NULL,
	"licence_constatee" text,
	"publiable" boolean DEFAULT false NOT NULL,
	"motif_non_publiable" text,
	"url_notice" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ocr_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"moteur" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"last_error" text,
	"demande_par_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "page_ocr" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"moteur" text NOT NULL,
	"texte" text NOT NULL,
	"texte_sha256" text NOT NULL,
	"accord_document_millimes" integer,
	"reconnu_lexique_millimes" integer,
	"incertitudes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"produit_par_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pages" (
	"id" text PRIMARY KEY NOT NULL,
	"livre_id" text NOT NULL,
	"folio" integer NOT NULL,
	"page_imprimee" text,
	"texte_ocr" text,
	"ocr_moteur" text,
	"ocr_bits_par_caractere_millimes" integer,
	"image_sha256" text,
	"image_largeur" integer,
	"image_hauteur" integer,
	"publiable" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ocr_jobs" ADD CONSTRAINT "ocr_jobs_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ocr_jobs" ADD CONSTRAINT "ocr_jobs_demande_par_user_id_users_id_fk" FOREIGN KEY ("demande_par_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_ocr" ADD CONSTRAINT "page_ocr_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_ocr" ADD CONSTRAINT "page_ocr_produit_par_user_id_users_id_fk" FOREIGN KEY ("produit_par_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pages" ADD CONSTRAINT "pages_livre_id_livres_id_fk" FOREIGN KEY ("livre_id") REFERENCES "public"."livres"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "livres_source_uq" ON "livres" USING btree ("source","source_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "livres_publiable_idx" ON "livres" USING btree ("publiable","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ocr_jobs_status_idx" ON "ocr_jobs" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ocr_jobs_page_moteur_uq" ON "ocr_jobs" USING btree ("page_id","moteur");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_ocr_page_idx" ON "page_ocr" USING btree ("page_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pages_livre_folio_uq" ON "pages" USING btree ("livre_id","folio");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pages_image_idx" ON "pages" USING btree ("image_sha256");--> statement-breakpoint
-- ── Trois règles que la base tient, et que le code ne tiendrait pas seul ─────

-- 1. Un récit est une expression du folklore (loi malgache 94-036, art. 5, 15°).
--    Même contrainte que sur `tales` : ce n'est pas un choix d'utilisateur, et un
--    export ne doit jamais pouvoir annoncer un statut que la loi ne reconnaît pas.
ALTER TABLE "livres" ADD CONSTRAINT "livres_statut_recit_ck"
  CHECK (statut_recit = 'EXPRESSION_DU_FOLKLORE');
--> statement-breakpoint

-- 2. Une page peut être MOINS publiable que son livre, jamais davantage.
--    C'est la leçon de ny_voary_1980 : le régime posé au niveau du fichier avait
--    fait sortir 33 documents non publiables sous l'étiquette « domaine public ».
--    Le sens de la restriction est ici inscrit en base plutôt que confié au code.
CREATE OR REPLACE FUNCTION page_pas_plus_permissive() RETURNS trigger AS $$
DECLARE livre_publiable boolean;
BEGIN
  IF NEW.publiable IS NULL OR NEW.publiable = false THEN RETURN NEW; END IF;
  SELECT publiable INTO livre_publiable FROM livres WHERE id = NEW.livre_id;
  IF livre_publiable IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'page % : un livre non publiable ne peut pas porter une page publiable', NEW.folio;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS pages_pas_plus_permissive ON "pages";
--> statement-breakpoint
CREATE TRIGGER pages_pas_plus_permissive
  BEFORE INSERT OR UPDATE ON "pages"
  FOR EACH ROW EXECUTE FUNCTION page_pas_plus_permissive();
--> statement-breakpoint

-- 3. Une océrisation ne se réécrit pas. Chaque passe — tesseract, vision,
--    transcription humaine — ajoute une ligne, parce qu'on ne sait pas laquelle
--    a raison : deux correcteurs entraînés sur ce corpus ont été rejetés APRÈS
--    avoir paru meilleurs. Écraser la précédente effacerait la comparaison qui
--    permet de le découvrir.
CREATE OR REPLACE FUNCTION page_ocr_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'page_ocr est append-only : ajoutez une passe, ne modifiez pas (ocr %)',
    OLD.id;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS page_ocr_no_update ON "page_ocr";
--> statement-breakpoint
CREATE TRIGGER page_ocr_no_update
  BEFORE UPDATE ON "page_ocr"
  FOR EACH ROW EXECUTE FUNCTION page_ocr_immutable();
