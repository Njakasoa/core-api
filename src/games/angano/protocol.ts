import type { Team } from "./roles.ts";

/**
 * Angano wire protocol (server-authoritative). Secret info (`role`, `seerResult`,
 * `wolves`, `narrator`) is only ever sent to the socket(s) entitled to it; the
 * public only sees `state` / `deaths` / `voteResult` / `finish`. The browser
 * mirrors these types.
 */

export type Phase =
  | "lobby" | "roles" | "cupidon" | "mpisikidy" | "songomby" | "ombiasy"
  | "aube" | "debat" | "vote" | "finished";

export interface PlayerPublic {
  id: string;
  name: string;
  alive: boolean;
  isNarrator: boolean;
}
export interface NarratorPlayer extends PlayerPublic { roleId?: string; loverId?: string }

export interface RoleInfo { roleId: string; team: Team; nameMg: string; desc: string; loverId?: string; loverName?: string }

export interface GameConfig { songomby: number; roles: string[] } // werewolf count + enabled optional roles

export type AnganoClientMsg =
  | { k: "hello"; name: string }
  | { k: "takeNarrator"; on: boolean }
  | { k: "setConfig"; config: GameConfig }              // host
  | { k: "start" }                                      // host
  | { k: "action"; targetId: string | null; extra?: string } // night action (role-contextual)
  | { k: "vote"; targetId: string | null }
  | { k: "nextPhase" }                                  // narrator pacing
  | { k: "rematch" };                                   // host

export type AnganoServerMsg =
  | { k: "lobby"; code: string; hostId: string; narratorId: string | null; selfId: string; config: GameConfig; players: PlayerPublic[] }
  | { k: "role"; role: RoleInfo }                       // private, to each player
  | { k: "narrator"; players: NarratorPlayer[]; log: string[] } // private, god view + live night log
  | { k: "phase"; phase: Phase; day: number; audioKey: string; imageKey: string; durationMs: number; title: string; text: string }
  | { k: "prompt"; kind: string; targets: PlayerPublic[]; options?: string[]; deadline: number } // to the acting player(s)
  | { k: "seerResult"; targetId: string; roleId: string; nameMg: string } // private, to the seer
  | { k: "wolves"; wolfIds: string[]; victimId: string | null }           // private, to the werewolves
  | { k: "deaths"; ids: string[]; reveals: { id: string; roleId: string; nameMg: string }[]; text: string } // public
  | { k: "voteState"; tally: { id: string; votes: number }[] }
  | { k: "voteResult"; eliminatedId: string | null; roleId?: string; nameMg?: string }
  | { k: "state"; phase: Phase; day: number; players: PlayerPublic[] }
  | { k: "finish"; winner: Team | "lovers"; text: string; reveal: { id: string; name: string; roleId: string; nameMg: string }[] }
  | { k: "error"; message: string };

// phase → recycled ambiance audio folder + placeholder image stem
export const PHASE_ASSET: Record<Phase, { audio: string; image: string }> = {
  lobby: { audio: "introduction", image: "introduction_phase" },
  roles: { audio: "introduction", image: "introduction_phase" },
  cupidon: { audio: "cupidon", image: "cupidon_phase" },
  mpisikidy: { audio: "voyante", image: "voyante_phase" },
  songomby: { audio: "loupgarou", image: "loup_garou_petite_fille_phase" },
  ombiasy: { audio: "sorciere", image: "sorciere_phase" },
  aube: { audio: "aube", image: "dawn_phase" },
  debat: { audio: "debat", image: "debat_phase" },
  vote: { audio: "vote", image: "vote_phase" },
  finished: { audio: "revelation", image: "revelation_phase" },
};

export const DEBATE_MS = 90_000;
export const NIGHT_STEP_MS = 30_000;
export const VOTE_MS = 45_000;
