CREATE TABLE IF NOT EXISTS "contributor_profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"display_name" text,
	"attribution" text DEFAULT 'nom_reel' NOT NULL,
	"region_declaree" text,
	"dialecte_declare" text,
	"restricted_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "corpus_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"org_id" text,
	"role" text NOT NULL,
	"scope" jsonb,
	"granted_by_user_id" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tale_consents" (
	"id" text PRIMARY KEY NOT NULL,
	"tale_id" text NOT NULL,
	"grantor_role" text NOT NULL,
	"grantor_user_id" text,
	"grantor_display" text NOT NULL,
	"attribution" text NOT NULL,
	"captured_via" text NOT NULL,
	"langue_du_formulaire" text NOT NULL,
	"finalites" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"niveau_irreversible_autorise" boolean DEFAULT false NOT NULL,
	"diffusion_publique_texte" boolean DEFAULT false NOT NULL,
	"diffusion_publique_audio" boolean DEFAULT false NOT NULL,
	"clonage_vocal" boolean DEFAULT false NOT NULL,
	"licence_accordee" text DEFAULT 'CC BY 4.0' NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"supersedes_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tale_families" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text,
	"split" text,
	"split_locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tale_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"tale_id" text NOT NULL,
	"kind" text NOT NULL,
	"texte" text NOT NULL,
	"texte_sha256" text NOT NULL,
	"origine" text NOT NULL,
	"author_user_id" text,
	"letter_delta_ppm" integer,
	"supersedes_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tales" (
	"id" text PRIMARY KEY NOT NULL,
	"submitter_user_id" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"nouveaute" text NOT NULL,
	"niveau" text DEFAULT 'variante' NOT NULL,
	"langue" text DEFAULT 'plt_Latn' NOT NULL,
	"dialecte_source" text,
	"dialecte" text,
	"region_collecte" text,
	"lieu_collecte" text,
	"titre_source" text NOT NULL,
	"titre" text,
	"genre_source" text,
	"famille_recit_id" text,
	"statut_recit" text DEFAULT 'EXPRESSION_DU_FOLKLORE' NOT NULL,
	"statut_fixation" text DEFAULT 'LICENCE_CC' NOT NULL,
	"provenance" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tk_labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"motifs_hors_liste" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"licence" text DEFAULT 'CC BY 4.0' NOT NULL,
	"regime" text DEFAULT 'cc_by_4_communaute' NOT NULL,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contributor_profiles" ADD CONSTRAINT "contributor_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "corpus_roles" ADD CONSTRAINT "corpus_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "corpus_roles" ADD CONSTRAINT "corpus_roles_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "corpus_roles" ADD CONSTRAINT "corpus_roles_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tale_consents" ADD CONSTRAINT "tale_consents_tale_id_tales_id_fk" FOREIGN KEY ("tale_id") REFERENCES "public"."tales"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tale_consents" ADD CONSTRAINT "tale_consents_grantor_user_id_users_id_fk" FOREIGN KEY ("grantor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tale_versions" ADD CONSTRAINT "tale_versions_tale_id_tales_id_fk" FOREIGN KEY ("tale_id") REFERENCES "public"."tales"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tale_versions" ADD CONSTRAINT "tale_versions_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tales" ADD CONSTRAINT "tales_submitter_user_id_users_id_fk" FOREIGN KEY ("submitter_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tales" ADD CONSTRAINT "tales_famille_recit_id_tale_families_id_fk" FOREIGN KEY ("famille_recit_id") REFERENCES "public"."tale_families"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "corpus_roles_user_idx" ON "corpus_roles" USING btree ("user_id","role");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "corpus_roles_org_idx" ON "corpus_roles" USING btree ("org_id","role");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tale_consent_tale_idx" ON "tale_consents" USING btree ("tale_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tale_version_brute_uq" ON "tale_versions" USING btree ("tale_id") WHERE kind = 'brute';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tale_version_tale_idx" ON "tale_versions" USING btree ("tale_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tale_version_sha_idx" ON "tale_versions" USING btree ("texte_sha256");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tales_status_idx" ON "tales" USING btree ("status","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tales_family_idx" ON "tales" USING btree ("famille_recit_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tales_submitter_idx" ON "tales" USING btree ("submitter_user_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tales_recent_idx" ON "tales" USING btree ("created_at","id");--> statement-breakpoint
-- ── Le texte brut est inaltérable, et c'est la base qui le garantit ──────────
--
-- `tale_versions.brute` est ce que le contributeur a soumis. Toute la
-- crédibilité du corpus repose sur le fait qu'il n'a pas bougé : le validateur
-- du dépôt de corpus échoue si la version corrigée s'écarte de la brute de plus
-- de 2 % de ses lettres, et ce contrôle ne veut rien dire si la brute peut être
-- réécrite entre-temps.
--
-- Ce déclencheur est ici et non dans le code applicatif parce qu'un contrôle
-- applicatif est à un `db.update()` distrait de disparaître — et personne ne le
-- saurait jamais. Une correction n'écrase pas : elle insère une nouvelle ligne
-- `corrigee` qui pointe vers celle qu'elle remplace.
CREATE OR REPLACE FUNCTION tale_brute_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'tale_versions.brute is append-only (tale %, version %)',
    OLD.tale_id, OLD.id;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS tale_versions_brute_no_update ON "tale_versions";
--> statement-breakpoint
CREATE TRIGGER tale_versions_brute_no_update
  BEFORE UPDATE OR DELETE ON "tale_versions"
  FOR EACH ROW WHEN (OLD.kind = 'brute')
  EXECUTE FUNCTION tale_brute_immutable();
--> statement-breakpoint
-- Un récit est une expression du folklore (loi malgache 94-036, art. 5, 15°).
-- Ce n'est pas un choix de l'utilisateur, et le colonne ne doit pas pouvoir
-- porter autre chose — sans quoi un export finirait par annoncer un statut
-- juridique que la loi ne reconnaît pas.
ALTER TABLE "tales" ADD CONSTRAINT "tales_statut_recit_ck"
  CHECK (statut_recit = 'EXPRESSION_DU_FOLKLORE');
