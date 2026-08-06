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
    /** Quand le contributeur a entendu ce conte — « dans mon enfance »,
     *  « vers 1988 ». Champ libre : une date exacte serait inventée, et une
     *  approximation vraie vaut mieux qu'une précision fausse.
     *  Son propre champ, et non un ajout à `lieuCollecte` : un lieu n'est pas
     *  une date, et le corpus lit ce champ-là. */
    quandEntendu: text("quand_entendu"),
    titreSource: text("titre_source").notNull(),
    titre: text("titre"),
    genreSource: text("genre_source"),
    familleRecitId: text("famille_recit_id").references(() => taleFamilies.id),
    /** L'amorce dont le contributeur dit que ce récit est une version —
     *  « renel_001 ». C'est une PROVENANCE DÉCLARÉE, pas le regroupement lui-même :
     *  `familleRecitId` reste dérivé, arbitré par un curateur.
     *
     *  Sans cette colonne, l'information était perdue à la saisie : l'écran sait
     *  que le conte est une variante de renel_001, l'affiche, et le POST ne le
     *  transmettait pas. Mesuré : 622 contes en base, 0 avec une famille. Deux
     *  récitations d'un même angano ne partagent presque aucun 5-gramme, donc
     *  aucune déduplication ne rattrape l'omission — et une variante qui tombe
     *  en test pendant que son jumeau est en train donne une évaluation fausse
     *  que rien ne révèle. */
    amorceId: text("amorce_id"),
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
    /** Ce que le contributeur DEMANDE. La porte d'entrée refuse la soumission
     *  si un conteur a accordé moins — voir couvre() dans lib/collecte. */
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
    /** SANS valeur par défaut, et c'est le cœur du sujet. Une colonne de la
     *  table de preuve qui se remplit toute seule affirme une chose que
     *  personne n'a dite. Mesuré avant correction : un contributeur envoyant
     *  « recherche non commerciale » recevait 201 et la ligne disait
     *  « CC BY 4.0 » — le plus permissif des choix, attribué à quelqu'un à qui
     *  on ne l'avait jamais soumis. Le dépôt de corpus pose la règle en toutes
     *  lettres : « Une obligation juridique ne prend pas de valeur par défaut. » */
    licenceAccordee: text("licence_accordee").notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull(),
    supersedesId: text("supersedes_id"),
    createdAt,
  },
  (t) => [index("tale_consent_tale_idx").on(t.taleId, t.id)],
);

// ═══════════════════════════════════════════════════════════════════════════
// Bibliothèque — les livres numérisés, leurs pages, leurs images
//
// POURQUOI ELLE EXISTE
// Le dépôt de corpus porte 44 volumes en texte, dont Callet 1908 (724 439 mots
// du bon registre). Ils sont inutilisables tels quels : le locuteur du projet a
// jugé illisibles les 40 phrases qu'on lui a soumises, y compris celles notées
// 82 %. Le texte seul ne permet ni de vérifier, ni de corriger, ni même de
// savoir ce que la page disait. La bibliothèque remet la page sous les yeux.
//
// LE FAIT QUI CONDITIONNE TOUT LE RESTE
// Un seul livre a ses images sur disque, et il n'est pas publiable. Les 1 782
// pages Gallica ont été téléchargées puis JETÉES — fetch_gallica.py écrivait un
// JPEG temporaire, appelait tesseract, puis faisait tmp.unlink(). Elles sont
// reconstructibles par une URL IIIF déterministe, au prix d'un anti-robot.
// Ces tables ne supposent donc AUCUNE image : un livre existe, ses pages
// existent, et l'image arrive plus tard ou jamais.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Un ouvrage numérisé.
 *
 * LES DROITS SONT PORTÉS PAR LE LIVRE **ET** PAR LA PAGE
 * `ny_voary_1980` déclare `publiable: false` sur 39 de ses 41 fiches et
 * `publiable: true` sur 2. Poser le régime au seul niveau du livre reproduirait
 * exactement l'erreur déjà commise dans build_dataset_deux_etapes.py, où 33
 * documents non publiables sont sortis étiquetés « domaine public ». Le livre
 * porte donc un défaut, et la page peut le restreindre — jamais l'élargir.
 *
 * `statutRecit` et `statutFixation` restent deux colonnes distinctes, comme
 * dans `tales` : le récit est une expression du folklore (loi 94-036 art. 5,
 * 15°), seule la fixation porte un droit d'auteur. Un livre de 1908 peut être
 * dans le domaine public sans que les récits qu'il contient cessent d'appartenir
 * à ceux qui les racontent.
 */
export const livres = pgTable(
  "livres",
  {
    id: text("id").primaryKey(),
    /** L'identifiant de la source : « bpt6k1502294r » chez Gallica,
     *  « tantaramyandria00antagoog » chez archive.org. C'est lui qui permet de
     *  reconstruire l'URL IIIF d'une page sans rien stocker de plus. */
    sourceRef: text("source_ref").notNull(),
    source: text("source").notNull(), // gallica | archive_org | scan_local | autre
    titre: text("titre").notNull(),
    auteur: text("auteur"),
    annee: integer("annee"),
    /** L'année de FIN, pour les ouvrages parus sur plusieurs millésimes.
     *  `bpt6k327620j` porte « 1930-1932 » dans le corpus, et une colonne entière
     *  ne peut pas le dire. Écraser la fourchette en `1930` serait une coercition
     *  muette ; la colonne existe pour que la seconde borne survive. */
    anneeFin: integer("annee_fin"),
    langue: text("langue").notNull().default("plt_Latn"),
    /** Le nombre de pages du livre. Peut être connu sans qu'aucune image le soit. */
    pagesTotal: integer("pages_total"),
    statutRecit: text("statut_recit").notNull().default("EXPRESSION_DU_FOLKLORE"),
    statutFixation: text("statut_fixation").notNull(), // DOMAINE_PUBLIC | SOUS_DROITS | LICENCE_CC | SOUS_DROITS_A_ETABLIR
    licence: text("licence").notNull(),
    /** Ce que la source a réellement affiché, recopié tel quel — jamais résumé.
     *  « domaine public (notice Gallica, lue le 2026-08-02) » n'est pas la même
     *  affirmation que « domaine public », et la seconde perd qui l'a dit. */
    licenceConstatee: text("licence_constatee"),
    /** Le défaut, restreignable page par page, jamais élargissable. */
    publiable: boolean("publiable").notNull().default(false),
    motifNonPubliable: text("motif_non_publiable"),
    urlNotice: text("url_notice"),

    /**
     * Qui a déposé ce livre. NUL pour les six volumes Gallica, versés par script
     * avant que quiconque puisse en déposer.
     *
     * Depuis que le téléversement est ouvert aux contributeurs, savoir de qui
     * vient un ouvrage n'est pas une commodité d'affichage : c'est ce qui permet
     * de le retirer entièrement quand son déposant le demande, et de savoir à
     * qui parler quand une revendication de droits arrive.
     */
    deposeParUserId: text("depose_par_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    /**
     * L'état de la MODÉRATION — et surtout pas celui des droits.
     *
     * `publiable` dit « avons-nous le droit », `statut_moderation` dit
     * « quelqu'un a-t-il vérifié ». Les confondre en une seule colonne ferait
     * disparaître la question qu'on ne pose pas : un ouvrage peut être
     * parfaitement libre de droits et n'avoir été relu par personne, et c'est
     * exactement l'état dans lequel arrive tout dépôt de contributeur.
     *
     * Un livre n'est LISTÉ publiquement qu'une fois accepté. Ses images, elles,
     * restent joignables par leur empreinte avant cela — c'est ce qui permet au
     * déposant de se relire et au modérateur de juger. L'empreinte imprévisible
     * est la capacité, comme partout ailleurs dans ce dépôt ; ce que la
     * modération protège, c'est la mise en avant, pas le secret.
     */
    statutModeration: text("statut_moderation").notNull().default("en_attente"),
    /** Pourquoi refusé. Un refus sans motif est un refus qu'on ne peut pas corriger. */
    motifModeration: text("motif_moderation"),
    modereParUserId: text("modere_par_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    modereLe: timestamp("modere_le", { withTimezone: true }),

    /**
     * LE RETRAIT A SES PROPRES COLONNES, ET C'EST UNE CORRECTION.
     *
     * Retirer un livre s'écrivait `publiable = false` + `motif_non_publiable`
     * rempli — exactement ce qu'écrit un dépôt déclaré SOUS DROITS par son
     * déposant, à la seconde où il arrive. Les deux états étaient donc
     * indiscernables, et « rétablir » l'un revenait à publier l'autre : une
     * œuvre que personne n'avait jamais eu le droit de publier.
     *
     * `motifNonPubliable` n'est plus jamais réécrit par un retrait. C'est la
     * déclaration du déposant sur les droits ; une décision de retrait est autre
     * chose, et l'écraser ferait disparaître la raison pour laquelle le livre
     * n'était pas publiable au départ.
     */
    retireLe: timestamp("retire_le", { withTimezone: true }),
    retireParUserId: text("retire_par_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    motifRetrait: text("motif_retrait"),
    /** Ce qu'il faudra remettre — et surtout pas `true`. Sans cette colonne,
     *  rétablir voudrait dire publier, y compris ce qui ne l'a jamais été. */
    publiableAvant: boolean("publiable_avant"),

    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex("livres_source_uq").on(t.source, t.sourceRef),
    index("livres_publiable_idx").on(t.publiable, t.id),
    /** La file de modération, et la liste publique, se lisent par cet index. */
    index("livres_moderation_idx").on(t.statutModeration, t.createdAt),
    index("livres_depose_par_idx").on(t.deposeParUserId),
    index("livres_retrait_idx").on(t.retireLe),
  ],
);

/**
 * Ce qui reste d'un livre supprimé définitivement : de quoi répondre, rien de plus.
 *
 * Une suppression détruit les octets et, par cascade, les pages, les
 * océrisations, les corrections proposées par des tiers et les avis rendus
 * dessus. Ne rien garder rendrait la question « pourquoi ce livre a-t-il
 * disparu ? » sans réponse — pour le déposant qui la posera en premier, et pour
 * l'ayant droit qui a demandé le retrait et voudra savoir qu'il a été fait.
 *
 * AUCUN CONTENU N'EST CONSERVÉ, PAS MÊME LES EMPREINTES. Les garder permettrait
 * de reconnaître un fichier reversé après coup — au prix de conserver la trace
 * de ce qu'un ayant droit a demandé d'effacer. Le titre et la source répondent
 * à la question ; l'empreinte, elle, ne fait que survivre au retrait.
 */
export const livresSupprimes = pgTable(
  "livres_supprimes",
  {
    id: text("id").primaryKey(),
    /** L'identifiant du livre disparu. PAS une clé étrangère : la ligne qu'elle
     *  désignerait n'existe plus, c'est tout l'objet de cette table. */
    livreId: text("livre_id").notNull(),
    titre: text("titre").notNull(),
    auteur: text("auteur"),
    annee: integer("annee"),
    source: text("source").notNull(),
    sourceRef: text("source_ref").notNull(),
    deposeParUserId: text("depose_par_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    supprimeParUserId: text("supprime_par_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    motif: text("motif").notNull(),
    /** Combien d'octets ont RÉELLEMENT été détruits, et combien de pages sont
     *  parties avec. Un zéro sur un livre de 374 folios dit que la boucle n'a
     *  pas fait son travail — sans ces chiffres, rien après coup ne permettrait
     *  de s'en apercevoir. */
    objetsDetruits: integer("objets_detruits").notNull().default(0),
    pagesSupprimees: integer("pages_supprimees").notNull().default(0),
    createdAt,
  },
  (t) => [
    /** Une suppression rejouée ne s'inscrit qu'une fois : la route est rejouable
     *  par construction, et le registre compterait sinon deux disparitions là où
     *  il n'y en a eu qu'une. */
    uniqueIndex("livres_supprimes_livre_uq").on(t.livreId),
    index("livres_supprimes_deposant_idx").on(t.deposeParUserId, t.createdAt),
  ],
);

/**
 * Une page d'un livre.
 *
 * `folio` est le numéro de vue de la source — le « f0012 » de Gallica — et non
 * le numéro imprimé sur le papier, qui peut manquer, se répéter ou repartir à
 * zéro. Les deux sont gardés quand on les connaît : confondre la vue et la page
 * imprimée rend une citation invérifiable.
 *
 * `imageSha256` est nul tant que l'image n'a pas été récupérée, ce qui est
 * l'état de 1 782 pages sur 1 783 aujourd'hui. Une page sans image reste une
 * page : elle porte son texte océrisé et sa qualité mesurée.
 */
export const pages = pgTable(
  "pages",
  {
    id: text("id").primaryKey(),
    livreId: text("livre_id")
      .notNull()
      .references(() => livres.id, { onDelete: "cascade" }),
    /** Numéro de VUE dans la source, celui qui construit l'URL IIIF. */
    folio: integer("folio").notNull(),
    /** Numéro IMPRIMÉ sur la page, quand il existe. Texte et non entier :
     *  « xii », « 12bis » et « — » sont des numéros de page réels. */
    pageImprimee: text("page_imprimee"),
    /** La PREMIÈRE lecture, gardée pour l'affichage de liste et le compte
     *  `pagesAvecTexte`. Ce n'est plus la lecture citable : celle-là est une
     *  ligne de `page_ocr`, immuable par déclencheur, et c'est la seule qu'une
     *  correction peut viser.
     *
     *  La distinction n'est pas théorique. `scripts/seed-bibliotheque.ts` fait
     *  `onConflictDoUpdate({ set: { texteOcr … } })` : rejouer le versement
     *  après une nouvelle océrisation réécrit cette colonne SUR PLACE. Des
     *  offsets enregistrés dedans deviendraient faux en silence. */
    texteOcr: text("texte_ocr"),
    ocrMoteur: text("ocr_moteur"), // tesseract-fra | vision | humain
    /** Score de detecter_ocr.py — bits par caractère, mesuré SANS lexique.
     *  Repères mesurés : Global Voices propre 1,84 · mg.wikipedia 2,36 ·
     *  Gallica folklore 2,54 · Callet 1908 4,15. */
    ocrBitsParCaractere: integer("ocr_bits_par_caractere_millimes"),
    imageSha256: text("image_sha256"),
    imageLargeur: integer("image_largeur"),
    imageHauteur: integer("image_hauteur"),
    /** La même page en 280 px, pour la grille.
     *  Une grille de 166 folios en images pleines fait 41 Mo et 166 bitmaps
     *  décodés ; `loading="lazy"` diffère le chargement, il ne le réduit pas.
     *  Son empreinte n'est jamais celle de `imageSha256` : la route qui sert les
     *  octets doit donc regarder LES DEUX colonnes, faute de quoi chaque
     *  vignette répond 404. */
    vignetteSha256: text("vignette_sha256"),
    /** Une page peut être moins publiable que son livre, jamais davantage. */
    publiable: boolean("publiable"),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex("pages_livre_folio_uq").on(t.livreId, t.folio),
    index("pages_image_idx").on(t.imageSha256),
    index("pages_vignette_idx").on(t.vignetteSha256),
  ],
);

/**
 * Les octets d'un objet stocké, adressés par leur empreinte. TOUTES FONCTIONNALITÉS.
 *
 * ELLE S'APPELAIT `images` ET N'A JAMAIS RANGÉ QUE DES OCTETS
 * Le nom la donnait à la bibliothèque ; l'adressage par contenu, lui, ne connaît
 * pas de propriétaire. La suite du projet stockera des photos de cahiers
 * envoyées par les contributeurs, des pièces jointes, des clips — et chacune
 * aurait redemandé sa table, sa route et son cache, avec l'occasion de se
 * tromper à chaque fois. Les droits restent chez le propriétaire : c'est le
 * registre de gardiens de lib/stockage/objets.ts, pas une colonne d'ici.
 *
 * L'adressage par sha256 reprend l'argument déjà écrit et justifié dans
 * routes/tts.ts : une empreinte imprévisible EST l'autorisation, parce qu'une
 * balise <img> ne porte pas de jeton. Il donne en prime la déduplication — deux
 * fonctionnalités qui manipulent les mêmes octets partagent l'objet.
 *
 * LE COÛT DU `bytea`, DIT PLUTÔT QUE TU : il gonfle les WAL, les sauvegardes et
 * la réplication du volume stocké, et chaque lecture est une ligne entière sans
 * requête par intervalle. Pour quelques milliers de pages c'est le bon
 * compromis ; le jour où chaque contributeur photographie un cahier, ce ne l'est
 * plus. D'où `stockage`, et d'où le fait que le passage à R2 n'ait touché ni le
 * contrat d'URL, ni les lignes, ni les clients.
 */
export const objets = pgTable(
  "objets",
  {
    sha256: text("sha256").primaryKey(),
    mime: text("mime").notNull(),
    octets: integer("octets").notNull(),
    /**
     * `original` ou `derive` — ce qui se régénère et ce qui ne se régénère pas.
     *
     * Une vignette, un transcodage, une synthèse vocale se refabriquent depuis
     * leur source ; un scan, une photo de cahier, non. C'est la seule
     * distinction dont l'infrastructure ait besoin : les règles de cycle de vie
     * travaillent par préfixe, donc `derive/` peut être purgé sans qu'aucune
     * règle ne puisse atteindre `original/` par accident. La classe entre dans
     * le nom de l'objet — voir lib/stockage/cles.ts.
     */
    classe: text("classe").notNull().default("original"),
    /**
     * Les octets eux-mêmes, quand ils sont ici. `bytea`, déclaré `text` côté
     * Drizzle. NUL quand `stockage = 'r2'` : c'est le déménagement, pas une
     * perte, et `objets_stockage_ck` interdit les deux états incohérents.
     */
    contenu: text("contenu"),
    /**
     * Où sont les octets de CETTE ligne — `db` ou `r2`.
     *
     * PAR LIGNE, ET SURTOUT PAS PAR VARIABLE D'ENVIRONNEMENT
     * Un drapeau global bascule d'un coup une base à moitié migrée : les lignes
     * encore en `bytea` deviennent illisibles à l'instant où on le tourne, et
     * rien ne le signale — la route rend 404, le navigateur affiche du blanc,
     * aucun journal ne dit pourquoi. En le portant sur la ligne, une base
     * mi-chemin est un état SERVABLE : chaque objet se lit là où il est
     * réellement, et `OBJETS_STOCKAGE` ne décide que de la destination des
     * prochains. C'est aussi ce qui rend le retour en arrière possible sans
     * rien réécrire.
     */
    stockage: text("stockage").notNull().default("db"),
    /**
     * Ce que le propriétaire sait de l'objet et que le dépôt n'a pas à
     * connaître : dimensions d'une image, durée d'un clip, provenance. Des
     * colonnes `largeur`/`hauteur` dans une table qui ne range plus seulement
     * des images obligeraient chaque nouveau type de fichier à en ajouter.
     */
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    /**
     * Qui a déposé ces octets. NUL pour tout ce qui vient d'un script.
     *
     * LE DÉPÔT NE CONNAÎT PAS SES CLIENTS, MAIS IL CONNAÎT SES DÉPOSANTS.
     * Ce n'est pas la même chose : la fonctionnalité qui se sert de l'objet
     * reste hors de cette table, mais le stockage lui-même a deux besoins que
     * personne d'autre ne peut couvrir — plafonner ce qu'un compte peut verser,
     * et rendre les octets d'une personne quand elle demande leur retrait.
     * Sans cette colonne, une route de téléversement ouverte est un robinet
     * qu'on ne peut ni mesurer ni fermer.
     */
    deposeParUserId: text("depose_par_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt,
  },
  (t) => [
    index("objets_stockage_idx").on(t.stockage, t.classe),
    /** Le quota se calcule par cet index : somme des octets d'un compte sur une
     *  fenêtre glissante. Sans lui, chaque téléversement balaierait la table. */
    index("objets_deposant_idx").on(t.deposeParUserId, t.createdAt),
  ],
);

/**
 * Une océrisation d'une page. APPEND-ONLY, et jamais une vérité.
 *
 * Chaque passe — tesseract, modèle de vision, transcription humaine — écrit une
 * ligne. Aucune n'écrase la précédente, parce qu'on ne sait pas laquelle a
 * raison : deux correcteurs d'OCR entraînés sur ce corpus ont déjà été REJETÉS
 * après avoir rendu le texte moins fidèle au document (74,96 % → 70,18 %) tout
 * en le rendant plus reconnaissable par le lexique (59,82 % → 76,46 %).
 *
 * `accordDocument` est la seule mesure qui décide, et elle n'existe que pour les
 * pages dont on possède une transcription humaine. Là où elle manque, la colonne
 * reste nulle — et une colonne nulle est une réponse : on ne sait pas.
 */
export const pageOcr = pgTable(
  "page_ocr",
  {
    id: text("id").primaryKey(),
    pageId: text("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    moteur: text("moteur").notNull(), // tesseract-fra | vision:<modele> | humain
    texte: text("texte").notNull(),
    texteSha256: text("texte_sha256").notNull(),
    /** Millièmes, pour comparer exactement sans flottant. */
    accordDocumentMillimes: integer("accord_document_millimes"),
    reconnuLexiqueMillimes: integer("reconnu_lexique_millimes"),
    /** Ce que le moteur a dit de sa propre incertitude, quand il en dit quelque
     *  chose. Un modèle de vision qui signale ses doutes vaut mieux qu'un score
     *  global, et se garde tel quel plutôt que résumé.
     *
     *  Un DÉSACCORD entre deux passes se range ici, et non dans une colonne
     *  scalaire : un scalaire par page dit « celle-ci a gagné », alors qu'un
     *  désaccord localisé dit « regarde ici », avec de quoi retrouver l'endroit
     *  sur le papier. La boîte englobante vient du TSV de tesseract. */
    incertitudes: jsonb("incertitudes")
      .$type<(string | DesaccordOcr)[]>()
      .notNull()
      .default([]),
    /** L'IDENTITÉ de la passe : version du moteur, empreinte du modèle de langue,
     *  --psm, drapeaux de dictionnaire, empreinte de l'image lue.
     *
     *  Sans elle, deux passes ne sont PAS comparables — `tesseract-mlg` depuis
     *  `tessdata` et depuis `tessdata_best` sont deux modèles différents, et
     *  `--psm 3` ne lit pas comme `--psm 6`. Refuser de désigner un vainqueur
     *  entre des lectures non reproductibles, ce serait refuser de classer des
     *  choses qui n'ont jamais été comparables. */
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    produitParUserId: text("produit_par_user_id").references(() => users.id),
    createdAt,
  },
  (t) => [index("page_ocr_page_idx").on(t.pageId, t.createdAt)],
);

/**
 * Une correction proposée sur un passage précis d'une lecture précise.
 *
 * CE QU'ELLE CORRIGE N'EST PAS « LA PAGE », C'EST UNE PASSE
 * `baseOcrId` désigne la ligne de `page_ocr` dans laquelle `debut` et `fin`
 * découpent. Sans elle, une correction acceptée sur la lecture `tesseract-fra`
 * s'appliquerait à des offsets qui, dans la lecture `tesseract-eng`, tombent au
 * milieu d'un autre mot. Il y a donc une version corrigée PAR LECTURE, jamais
 * une par page : en fusionner deux reviendrait à désigner une gagnante, ce que
 * ce module refuse partout ailleurs.
 *
 * `lu` recopie la sous-chaîne d'origine, et la base VÉRIFIE qu'elle correspond
 * (déclencheur `page_corrections_ancree`). L'écart n'est donc pas « détectable »,
 * il est inécrivable. C'est aussi le seul endroit où se fait la conversion entre
 * les offsets 0-indexés demi-ouverts de l'API et le `substr` 1-indexé de
 * Postgres — l'erreur de un que toute implémentation commet, écrite une fois.
 *
 * UN INTERVALLE VIDE EST REFUSÉ. Un `int4range` vide ne chevauche rien, donc
 * deux insertions acceptées au même point passeraient la contrainte d'exclusion
 * et s'appliqueraient dans un ordre indéterminé. Pour insérer un mot manquant,
 * on étend l'intervalle sur un mot voisin.
 *
 * `propose = ''` est LÉGITIME : c'est une suppression, et supprimer du bruit
 * inséré est la correction la plus fréquente sur ces pages.
 *
 * `propose` n'est JAMAIS normalisé ni rogné. Normaliser vers une forme canonique
 * est, en miniature, la faute qui a fait rejeter deux correcteurs d'OCR sur ce
 * corpus : ils gagnaient 16,6 points de reconnaissance lexicale en perdant 4,8
 * points de fidélité au document.
 *
 * LA CASCADE EST UN CHOIX DE DROITS. `lu` et `propose` sont des copies du texte
 * de la page. Un retrait exigé par un ayant droit qui laisserait ces lignes
 * debout garderait la page retirée en base sous un autre nom de table.
 */
export const pageCorrections = pgTable(
  "page_corrections",
  {
    id: text("id").primaryKey(),
    pageId: text("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    baseOcrId: text("base_ocr_id")
      .notNull()
      .references(() => pageOcr.id, { onDelete: "cascade" }),
    /** Offsets en points de code, 0-indexés, demi-ouverts [debut, fin). */
    debut: integer("debut").notNull(),
    fin: integer("fin").notNull(),
    lu: text("lu").notNull(),
    propose: text("propose").notNull(),
    motif: text("motif"),
    /** [x, y, largeur, hauteur] dans l'image lue, quand le client la connaît.
     *  Même rôle que dans `DesaccordOcr` : de quoi en appeler au papier. */
    bbox: jsonb("bbox").$type<[number, number, number, number]>(),
    proposeParUserId: text("propose_par_user_id")
      .notNull()
      .references(() => users.id),
    // proposee | acceptee | refusee | retiree | obsolete | revoquee
    statut: text("statut").notNull().default("proposee"),
    /** { par, le, motif } — la seule sortie d'une acceptation erronée. Sans
     *  elle, un intervalle accepté à tort est verrouillé à vie : la ligne est
     *  immuable et la contrainte d'exclusion interdit toute rivale. Or l'erreur
     *  qu'on redoute — accepter une modernisation de l'orthographe — est
     *  exactement celle que ce corpus a déjà subie. */
    revocation: jsonb("revocation").$type<{
      par: string;
      le: string;
      motif: string;
    }>(),
    createdAt,
  },
  (t) => [
    /** La file du relecteur : par page puis par position, JAMAIS par date. Un
     *  ordre chronologique donne une file entièrement possédée par le dernier
     *  arrivé. */
    index("page_corrections_file_idx").on(t.statut, t.pageId, t.debut),
    index("page_corrections_base_idx").on(t.baseOcrId, t.debut),
    index("page_corrections_auteur_idx").on(t.proposeParUserId, t.createdAt),
    /** Un double-clic n'est pas un second avis. */
    uniqueIndex("page_corrections_doublon_uq")
      .on(t.baseOcrId, t.debut, t.fin, t.proposeParUserId)
      .where(sql`statut = 'proposee'`),
  ],
);

/**
 * L'avis d'UN relecteur sur UNE proposition. Append-only.
 *
 * POURQUOI UNE TABLE ET NON DEUX COLONNES SUR LA CORRECTION
 * Le protocole de relecture de ce projet (repparcs/scripts/kit_relecture.py)
 * pose depuis toujours que « vos jugements sont conservés individuellement…
 * ils ne sont jamais fondus dans une moyenne », et qu'un désaccord est un
 * résultat qu'on publie plutôt qu'un problème qu'on arbitre. Deux colonnes
 * `decide_par` / `decide_le` rendraient le second avis impossible à écrire.
 *
 * Le seuil vit dans `page_correction_statut()` : `accords_requis = 1`
 * aujourd'hui. Le porter à deux relecteurs de régions différentes — ce que le
 * kit exige déjà hors ligne — sera une ligne de migration, pas un changement de
 * schéma.
 */
export const pageCorrectionAvis = pgTable(
  "page_correction_avis",
  {
    id: text("id").primaryKey(),
    correctionId: text("correction_id")
      .notNull()
      .references(() => pageCorrections.id, { onDelete: "cascade" }),
    relecteurUserId: text("relecteur_user_id")
      .notNull()
      .references(() => users.id),
    avis: text("avis").notNull(), // accord | desaccord
    motif: text("motif"),
    createdAt,
  },
  (t) => [
    uniqueIndex("page_correction_avis_uq").on(t.correctionId, t.relecteurUserId),
    index("page_correction_avis_relecteur_idx").on(t.relecteurUserId, t.createdAt),
  ],
);

export type PageCorrection = typeof pageCorrections.$inferSelect;
export type PageCorrectionAvis = typeof pageCorrectionAvis.$inferSelect;

/** Un endroit précis où deux passes ne lisent pas la même chose. */
export interface DesaccordOcr {
  type: "desaccord";
  /** L'identifiant de la passe à laquelle on se compare. */
  contre: string;
  lu: string;
  autre: string;
  /** [x, y, largeur, hauteur] dans l'image lue — de quoi montrer le papier. */
  bbox?: [number, number, number, number];
  /** La confiance du moteur sur ce mot, telle qu'il la donne. C'est le seul
   *  nombre qui vienne de la lecture elle-même et non d'un juge fabriqué ici. */
  conf?: number;
}

/**
 * La file des travaux d'océrisation.
 *
 * Reprise du patron de `webhook_deliveries` — status, attempts, nextAttemptAt,
 * lastError, index sur (status, next_attempt_at), recul exponentiel — avec UNE
 * différence obligatoire au moment de la prise : `FOR UPDATE SKIP LOCKED`.
 * Les webhooks s'en passent parce qu'un doublon d'envoi est tolérable ; un
 * doublon d'appel à un modèle de vision se paie.
 */
export const ocrJobs = pgTable(
  "ocr_jobs",
  {
    id: text("id").primaryKey(),
    pageId: text("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    moteur: text("moteur").notNull(),
    status: text("status").notNull().default("pending"), // pending | running | success | failed
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    /** Pris à un instant donné par un ouvrier donné. Sans bail, deux répliques
     *  paieraient deux fois le même appel. */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    lastError: text("last_error"),
    demandeParUserId: text("demande_par_user_id").references(() => users.id),
    createdAt,
    updatedAt,
  },
  (t) => [
    index("ocr_jobs_status_idx").on(t.status, t.nextAttemptAt),
    /** UNIQUE seulement sur les travaux EN COURS.
     *
     *  Un index total verrouillerait un moteur à vie sur une page : une fois la
     *  passe réussie, on ne pourrait plus la rejouer après une mise à jour du
     *  modèle ni après avoir récupéré une meilleure image. Or `page_ocr` n'a
     *  volontairement pas d'unicité (page, moteur) — les passes multiples sont
     *  le principe. La file doit dire la même chose que le registre : ce qu'on
     *  empêche, c'est de payer deux fois le travail en cours. */
    uniqueIndex("ocr_jobs_actif_uq")
      .on(t.pageId, t.moteur)
      .where(sql`${t.status} in ('pending', 'running')`),
  ],
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
export type Livre = typeof livres.$inferSelect;
export type Page = typeof pages.$inferSelect;
export type PageOcr = typeof pageOcr.$inferSelect;
export type OcrJob = typeof ocrJobs.$inferSelect;
