/**
 * Angano role catalog. Malagasy-folklore roles with recycled placeholder art keys.
 * The narrator is a seat, not a role. Names/descriptions live only here.
 *
 * V2 identity = "fady / traces / esprits" (not "loup-garou skinné"). The lovers
 * mechanic (Cupidon) is removed. See docs/roles-folklore-finalise-v2.md.
 *
 * Teams: "village" vs "songomby" (the antagonist camp, used for the parity win)
 * plus "neutre" for personal objectives. The pack is narrower than the team:
 * only actual Songomby see each other and take part in the night kill.
 */
export type Team = "village" | "songomby" | "neutre";

export interface RoleDef {
  id: string;
  nameMg: string;
  desc: string;
  team: Team;
  asset: string;     // placeholder image key (filename stem in public/assets/images)
  optional: boolean; // togglable in the lobby config
}

export const ROLES: Record<string, RoleDef> = {
  mponina: {
    id: "mponina", nameMg: "Mponina", team: "village", asset: "role_mponina", optional: false,
    desc: "Aucun pouvoir nocturne. Observe, débat et vote pour chasser les monstres.",
  },
  songomby: {
    id: "songomby", nameMg: "Songomby", team: "songomby", asset: "role_songomby", optional: false,
    desc: "Bête mangeuse d'hommes, rapide comme le vent. Chaque nuit, les Songomby choisissent ensemble une victime à dévorer.",
  },
  mpisikidy: {
    id: "mpisikidy", nameMg: "Mpisikidy", team: "village", asset: "role_mpisikidy", optional: true,
    desc: "Devin du Sikidy. Chaque nuit, lis les signes d'un joueur : tu découvres son rôle apparent, sauf si les signes sont masqués.",
  },
  ombiasy: {
    id: "ombiasy", nameMg: "Ombiasy", team: "village", asset: "role_ombiasy", optional: true,
    desc: "Guérisseur et gardien spirituel. Une fois, sauve la victime ; une fois, accomplis un rituel d'exil contre un joueur dangereux.",
  },
  fanany: {
    id: "fanany", nameMg: "Fanany", team: "village", asset: "role_fanany", optional: true,
    desc: "Serpent des ancêtres. Chaque jour, marque secrètement un joueur : si tu meurs avant le prochain jour, la vengeance des Razana l'emporte.",
  },
  zazavavindrano: {
    id: "zazavavindrano", nameMg: "Zazavavindrano", team: "village", asset: "role_zazavavindrano", optional: true,
    desc: "Esprit des eaux sacrées. Chaque nuit, lie un joueur au Fady des eaux : si une force hostile le trouble, tu sentiras sa trace.",
  },
  kalanoro: {
    id: "kalanoro", nameMg: "Kalanoro", team: "village", asset: "role_kalanoro", optional: true,
    desc: "Gardien des traces inversées. Chaque nuit, piste un joueur différent de la nuit précédente : tu sauras s'il a quitté sa place.",
  },
  kinoly: {
    id: "kinoly", nameMg: "Kinoly", team: "neutre", asset: "role_kinoly", optional: true,
    desc: "Revenant neutre dormant. La première fois que tu devrais mourir la nuit, tu survis et t'éveilles ; ensuite, tu peux hanter un joueur chaque nuit. Le vote te tue normalement. Paraît Mponina au Mpisikidy.",
  },
  mpamosavy: {
    id: "mpamosavy", nameMg: "Mpamosavy", team: "songomby", asset: "role_mpamosavy", optional: true,
    desc: "Humain à double vie et sorcier nocturne. Chaque nuit, maudis un joueur différent de la nuit précédente : son pouvoir échoue.",
  },
};

/** Roles that take part in the nightly pack kill (and see/choose with the wolves). */
export const PACK_KILLERS: ReadonlySet<string> = new Set(["songomby"]);
export const isPackKiller = (id: string | undefined): boolean => !!id && PACK_KILLERS.has(id);

export const OPTIONAL_ROLES = Object.values(ROLES).filter((r) => r.optional).map((r) => r.id);
export const roleName = (id: string): string => ROLES[id]?.nameMg ?? id;
export const roleTeam = (id: string): Team => ROLES[id]?.team ?? "village";
