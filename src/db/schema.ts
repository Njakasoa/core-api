import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** Shared column helpers. IDs are prefixed nanoids (see lib/ids.ts). */
const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow();

// ── Users ────────────────────────────────────────────────
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    name: text("name"),
    // 2FA / TOTP
    totpSecret: text("totp_secret"),
    totpEnabled: boolean("totp_enabled").notNull().default(false),
    recoveryCodes: jsonb("recovery_codes").$type<string[]>(),
    createdAt,
    updatedAt,
  },
  (t) => [uniqueIndex("users_email_uq").on(sql`lower(${t.email})`)],
);

// ── Refresh tokens (hashed, rotating) ────────────────────
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [
    index("refresh_user_idx").on(t.userId),
    uniqueIndex("refresh_hash_uq").on(t.tokenHash),
  ],
);

// ── Organizations (tenants) ──────────────────────────────
export const orgs = pgTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  createdAt,
  updatedAt,
});

export const orgMembers = pgTable(
  "org_members",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"), // owner | admin | member
    createdAt,
  },
  (t) => [
    uniqueIndex("org_member_uq").on(t.orgId, t.userId),
    index("org_member_user_idx").on(t.userId),
  ],
);

// ── API keys (machine-to-machine) ────────────────────────
export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Only the hash is stored; the plaintext is shown once at creation.
    keyHash: text("key_hash").notNull(),
    prefix: text("prefix").notNull(), // first chars, shown for identification
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [
    uniqueIndex("api_key_hash_uq").on(t.keyHash),
    index("api_key_org_idx").on(t.orgId),
  ],
);

// ── Idempotency keys ─────────────────────────────────────
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: text("id").primaryKey(), // the client-supplied key, scoped by org+method+path
    orgId: text("org_id"),
    requestHash: text("request_hash").notNull(),
    statusCode: integer("status_code").notNull(),
    responseBody: jsonb("response_body"),
    createdAt,
  },
);

// ── Webhooks ─────────────────────────────────────────────
export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    secret: text("secret").notNull(),
    events: jsonb("events").$type<string[]>().notNull().default([]), // [] = all
    active: boolean("active").notNull().default(true),
    createdAt,
  },
  (t) => [index("webhook_org_idx").on(t.orgId)],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"), // pending | success | failed
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt,
  },
  (t) => [index("delivery_status_idx").on(t.status, t.nextAttemptAt)],
);

// ── Items (sample resource — copy this to add your own) ──
export const items = pgTable(
  "items",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    data: jsonb("data"),
    createdAt,
    updatedAt,
  },
  (t) => [index("items_org_idx").on(t.orgId, t.id)],
);

// ═══════════════════════════════════════════════════════════════════════════
// Collecte — community platform for Malagasy folktales (angano)
//
// A row in `tales` is a SUBMISSION moving through a workflow. It is not a
// corpus record. The corpus record is an export artifact carrying ~40 fields,
// produced by repparcs/scripts from these tables at release time. Conflating
// the two would make every column nullable (a draft has none of them) and
// would store `split` and `familleRecitId` on a row where they are derived.
//
// Three invariants of the corpus dictate the shape below, and each is enforced
// here rather than trusted:
//   · `statutRecit` and `statutFixation` never merge. The tale is an expression
//     of folklore (loi malgache 94-036 art. 5, 15°); only the fixation carries
//     copyright.
//   · The raw text is never overwritten — see `taleVersions`.
//   · `validation_communautaire` stays null until a NAMED community authority
//     fills it. It is deliberately absent as a column: it is a view over a
//     future `community_validations` table, because a denormalised copy is how
//     one ships a non-null value with no authority behind it.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Site-wide roles, which `org_members.role` cannot express.
 *
 * Not a column on `users`: that table is shared with auth and orgs, and the
 * repo deliberately has no global role. Not `requireRole()` either — every
 * registrant is `owner` of the org created for them at signup, so an org role
 * can never mean "moderator of the platform". It is a limit of what org roles
 * can say, not a hole in them.
 *
 * `orgId` rather than `userId` for `communaute`: a community authority is an
 * institution, not a person. Exactly one of the two is set.
 */
export const corpusRoles = pgTable(
  "corpus_roles",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    orgId: text("org_id").references(() => orgs.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // moderateur | curateur | relecteur | communaute
    /** Optional narrowing, e.g. a reviewer for one dialect. */
    scope: jsonb("scope").$type<{ regions?: string[]; dialectes?: string[] }>(),
    grantedByUserId: text("granted_by_user_id")
      .notNull()
      .references(() => users.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [
    index("corpus_roles_user_idx").on(t.userId, t.role),
    index("corpus_roles_org_idx").on(t.orgId, t.role),
  ],
);

/**
 * What a contributor tells us about themselves.
 *
 * `attribution` is REVISABLE AT ANY TIME and therefore resolved live at export
 * — the review protocol promises exactly that. Contrast with the reviewer's
 * region and dialect, which are snapshotted onto each review: people move, and
 * a join there would silently rewrite what was said and by whom. Two opposite
 * rules, both deliberate.
 */
export const contributorProfiles = pgTable("contributor_profiles", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  displayName: text("display_name"),
  attribution: text("attribution").notNull().default("nom_reel"), // nom_reel | pseudonyme | anonyme
  regionDeclaree: text("region_declaree"),
  dialecteDeclare: text("dialecte_declare"),
  restrictedUntil: timestamp("restricted_until", { withTimezone: true }),
  createdAt,
  updatedAt,
});

/**
 * Variant grouping. The unit the train/test split is computed on, never the
 * tale: two tellings of one angano share the plot but almost no 5-gram, so
 * lexical deduplication does not see them and a per-tale split would put a
 * variant in train and its sibling in test.
 *
 * `split` is FROZEN at first export. A later submission declaring itself a
 * variant of two existing families merges them, which changes the id, which
 * changes the hash, which would move an already-published tale from test to
 * train. `validate.py` cannot catch that — it only ever sees one file.
 */
export const taleFamilies = pgTable("tale_families", {
  id: text("id").primaryKey(),
  label: text("label"),
  split: text("split"), // train | dev | test — null until first export
  splitLockedAt: timestamp("split_locked_at", { withTimezone: true }),
  createdAt,
  updatedAt,
});

export const tales = pgTable(
  "tales",
  {
    id: text("id").primaryKey(),
    /** `restrict`, not `cascade`: deleting an account must not delete the
     *  cultural heritage it carried, nor the consent recorded against it.
     *  Erasing a person is done by anonymising their profile. */
    submitterUserId: text("submitter_user_id")
      .notNull()
      .references(() => users.id),
    // draft | submitted | in_review | needs_changes | accepted | rejected | withdrawn | quarantined
    status: text("status").notNull().default("draft"),
    /** INEDIT_ORAL | DEJA_ATTESTE — an oral telling never written down, or a
     *  tale already published elsewhere. Both are accepted; the corpus can be
     *  filtered on this, so it must be declared and not inferred. */
    nouveaute: text("nouveaute").notNull(),
    niveau: text("niveau").notNull().default("variante"),
    langue: text("langue").notNull().default("plt_Latn"),
    /** As the contributor wrote it. Never overwritten — the canonical form goes
     *  in the column beside it, the same discipline as titre/titreSource. */
    dialecteSource: text("dialecte_source"),
    dialecte: text("dialecte"),
    regionCollecte: text("region_collecte"),
    lieuCollecte: text("lieu_collecte"),
    titreSource: text("titre_source").notNull(),
    titre: text("titre"),
    genreSource: text("genre_source"),
    familleRecitId: text("famille_recit_id").references(() => taleFamilies.id),
    /** Single value by law, kept as a column so the export cannot forget it. */
    statutRecit: text("statut_recit").notNull().default("EXPRESSION_DU_FOLKLORE"),
    statutFixation: text("statut_fixation").notNull().default("LICENCE_CC"),
    provenance: jsonb("provenance").$type<string[]>().notNull().default([]),
    notices: jsonb("notices").$type<string[]>().notNull().default([]),
    /** Local Contexts TK Labels can only be posted from a Community account.
     *  Empty until one does; never derived, never inferred. */
    tkLabels: jsonb("tk_labels").$type<string[]>().notNull().default([]),
    motifsHorsListe: jsonb("motifs_hors_liste").$type<string[]>().notNull().default([]),
    /** A new regime, not the public-domain one: the text of a community
     *  contribution is not public domain. Export writes one file per regime,
     *  and merging them would subject everything to the strictest clause
     *  without it being visible anywhere. */
    licence: text("licence").notNull().default("CC BY 4.0"),
    regime: text("regime").notNull().default("cc_by_4_communaute"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [
    index("tales_status_idx").on(t.status, t.id),
    index("tales_family_idx").on(t.familleRecitId, t.id),
    index("tales_submitter_idx").on(t.submitterUserId, t.id),
    index("tales_recent_idx").on(t.createdAt, t.id),
  ],
);

/**
 * The text, in named versions. Append-only.
 *
 * `brute` is what the contributor submitted and it is written ONCE. The whole
 * credibility of the corpus rests on that property, so a unique partial index
 * makes a second one impossible and a database trigger (see the migration)
 * refuses any update or delete. An application-level check would be one
 * careless `db.update()` away from gone, and nobody would ever know.
 *
 * A correction never mutates: it inserts a new `corrigee` pointing at the one
 * it supersedes. `letterDelta` records how far it drifted from the raw form,
 * using the same letters-only normalisation as repparcs/scripts/validate.py,
 * which fails a build past 2 % — cleaning may touch layout, never wording.
 */
export const taleVersions = pgTable(
  "tale_versions",
  {
    id: text("id").primaryKey(),
    taleId: text("tale_id")
      .notNull()
      .references(() => tales.id),
    kind: text("kind").notNull(), // brute | corrigee
    texte: text("texte").notNull(),
    texteSha256: text("texte_sha256").notNull(),
    /** How this version came to be: "saisie du contributeur",
     *  "transcription d'un enregistrement", "césures recollées". */
    origine: text("origine").notNull(),
    authorUserId: text("author_user_id").references(() => users.id),
    letterDelta: integer("letter_delta_ppm"), // parts per million, integer to stay exact
    supersedesId: text("supersedes_id"),
    createdAt,
  },
  (t) => [
    uniqueIndex("tale_version_brute_uq")
      .on(t.taleId)
      .where(sql`kind = 'brute'`),
    index("tale_version_tale_idx").on(t.taleId, t.id),
    index("tale_version_sha_idx").on(t.texteSha256),
  ],
);

/**
 * Consent, granted by a PERSON — not a property of the submission.
 *
 * This is the failure mode that would invalidate everything downstream: a
 * contributor records their grandmother, uploads it, ticks CC BY 4.0. The
 * grandmother granted nothing, and she is precisely who the folklore regime
 * and the Local Contexts apparatus exist to protect. So: one row per grantor,
 * with their role, their name, and the language the form was in — consent
 * obtained in French from a Malagasy-speaking teller is not informed consent.
 *
 * Append-only, never updated: a consent that can be edited is not evidence.
 * `niveauIrreversibleAutorise` defaults to false because model weights can only
 * be unwound by retraining, and that must be opted into, never assumed.
 */
export const taleConsents = pgTable(
  "tale_consents",
  {
    id: text("id").primaryKey(),
    taleId: text("tale_id")
      .notNull()
      .references(() => tales.id),
    grantorRole: text("grantor_role").notNull(), // conteur | transcripteur | deposant | ayant_droit
    /** Often absent: the teller usually has no account. */
    grantorUserId: text("grantor_user_id").references(() => users.id),
    grantorDisplay: text("grantor_display").notNull(),
    attribution: text("attribution").notNull(), // nom_reel | pseudonyme | anonyme
    capturedVia: text("captured_via").notNull(), // formulaire_web | papier_scanne | oral_enregistre
    langueDuFormulaire: text("langue_du_formulaire").notNull(), // plt_Latn | fra_Latn
    finalites: jsonb("finalites").$type<string[]>().notNull().default([]),
    niveauIrreversibleAutorise: boolean("niveau_irreversible_autorise")
      .notNull()
      .default(false),
    diffusionPubliqueTexte: boolean("diffusion_publique_texte").notNull().default(false),
    diffusionPubliqueAudio: boolean("diffusion_publique_audio").notNull().default(false),
    /** Its own permission. "You may publish the recording" and "you may train a
     *  voice model on my grandmother's voice" are not the same sentence. */
    clonageVocal: boolean("clonage_vocal").notNull().default(false),
    licenceAccordee: text("licence_accordee").notNull().default("CC BY 4.0"),
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull(),
    supersedesId: text("supersedes_id"),
    createdAt,
  },
  (t) => [index("tale_consent_tale_idx").on(t.taleId, t.id)],
);

export type User = typeof users.$inferSelect;
export type Org = typeof orgs.$inferSelect;
export type OrgMember = typeof orgMembers.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Item = typeof items.$inferSelect;
export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;
export type CorpusRole = typeof corpusRoles.$inferSelect;
export type ContributorProfile = typeof contributorProfiles.$inferSelect;
export type TaleFamily = typeof taleFamilies.$inferSelect;
export type Tale = typeof tales.$inferSelect;
export type TaleVersion = typeof taleVersions.$inferSelect;
export type TaleConsent = typeof taleConsents.$inferSelect;
