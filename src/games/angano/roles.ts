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
    desc: "Chaque nuit, les Songomby choisissent ensemble une victime à dévorer.",
  },
  mpisikidy: {
    id: "mpisikidy", nameMg: "Mpisikidy", team: "village", asset: "role_mpisikidy", optional: true,
    desc: "Chaque nuit, le sikidy te révèle le rôle d'un joueur — mais les traces peuvent brouiller la lecture.",
  },
  ombiasy: {
    id: "ombiasy", nameMg: "Ombiasy", team: "village", asset: "role_ombiasy", optional: true,
    desc: "Un remède (sauver la victime) et un poison (tuer), chacun utilisable une seule fois.",
  },
  mpihaza: {
    id: "mpihaza", nameMg: "Mpihaza", team: "village", asset: "role_mpihaza", optional: true,
    desc: "Quand tu meurs, tu décoches une dernière flèche et emportes un joueur.",
  },
  zazavavindrano: {
    id: "zazavavindrano", nameMg: "Zazavavindrano", team: "village", asset: "role_zazavavindrano", optional: true,
    desc: "Chaque nuit, pose un fady d'eau sur un joueur. Si une force hostile le trouble, tu sentiras sa trace.",
  },
  kalanoro: {
    id: "kalanoro", nameMg: "Kalanoro", team: "village", asset: "role_kalanoro", optional: true,
    desc: "Chaque nuit, lis les pas d'un joueur : tu sauras s'il a quitté sa place cette nuit.",
  },
  kinoly: {
    id: "kinoly", nameMg: "Kinoly", team: "neutre", asset: "role_kinoly", optional: true,
    desc: "Revenant neutre. Chaque nuit, hante un joueur ; gagne personnellement s'il survit après avoir vu une cible hantée mourir au vote. Paraît Mponina au Mpisikidy.",
  },
  mpamosavy: {
    id: "mpamosavy", nameMg: "Mpamosavy", team: "songomby", asset: "role_mpamosavy", optional: true,
    desc: "Chaque nuit, tu maudis un joueur : son pouvoir nocturne échoue.",
  },
};

/** Roles that take part in the nightly pack kill (and see/choose with the wolves). */
export const PACK_KILLERS: ReadonlySet<string> = new Set(["songomby"]);
export const isPackKiller = (id: string | undefined): boolean => !!id && PACK_KILLERS.has(id);

export const OPTIONAL_ROLES = Object.values(ROLES).filter((r) => r.optional).map((r) => r.id);
export const roleName = (id: string): string => ROLES[id]?.nameMg ?? id;
export const roleTeam = (id: string): Team => ROLES[id]?.team ?? "village";
