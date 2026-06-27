import type { Team } from "./roles.ts";

/**
 * Angano wire protocol (server-authoritative). Secret info (`role`, `seerResult`,
 * `trackResult`, `fadyTrace`, `blocked`, `wolves`, `narrator`) is only ever sent to
 * the socket(s) entitled to it; the public only sees `state` / `deaths` /
 * `voteResult` / `finish`. The browser mirrors these types.
 *
 * V2: the night is collected then resolved in a fixed order (marks → blocks → info
 * → kills → saves → traces). Private night results (seer / tracker / fady trace /
 * roleblock) therefore arrive at dawn, not during the acting step.
 */

export type Phase =
  | "lobby" | "roles"
  | "zazavavindrano" | "mpamosavy" | "mpisikidy" | "kalanoro" | "songomby" | "ombiasy"
  | "aube" | "debat" | "vote" | "finished";

export interface PlayerPublic {
  id: string;
  name: string;
  alive: boolean;
  isNarrator: boolean;
}
export interface NarratorPlayer extends PlayerPublic { roleId?: string }

export interface RoleInfo { roleId: string; team: Team; nameMg: string; desc: string }

export type Pace = "rapide" | "normal" | "lent";
export interface GameConfig { songomby: number; roles: string[]; pace?: Pace; manualDeaths?: boolean } // pack size + optional roles + pacing

// phase durations per pace tier (ms)
export const PACE_MS: Record<Pace, { night: number; debate: number; vote: number }> = {
  rapide: { night: 20_000, debate: 60_000, vote: 30_000 },
  normal: { night: 30_000, debate: 90_000, vote: 45_000 },
  lent: { night: 45_000, debate: 120_000, vote: 70_000 },
};

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
  | { k: "seerResult"; targetId: string; roleId: string; nameMg: string } // private, Mpisikidy (at dawn)
  | { k: "trackResult"; targetId: string; visited: boolean }              // private, Kalanoro (at dawn)
  | { k: "fadyTrace"; targetId: string }                                  // private, Zazavavindrano (at dawn)
  | { k: "blocked" }                                                      // private, a roleblocked actor (at dawn)
  | { k: "wolves"; wolfIds: string[]; victimId: string | null }           // private, to the pack
  | { k: "deaths"; ids: string[]; reveals: { id: string; roleId: string; nameMg: string }[]; text: string } // public
  | { k: "voteState"; tally: { id: string; votes: number }[] }
  | { k: "voteResult"; eliminatedId: string | null; roleId?: string; nameMg?: string }
  | { k: "state"; phase: Phase; day: number; players: PlayerPublic[] }
  | { k: "finish"; winner: Team; text: string; reveal: { id: string; name: string; roleId: string; nameMg: string }[] }
  | { k: "error"; message: string };

// phase → ambiance audio folder + image stem. Night turns use the painted power
// banners; scene phases (lobby/aube/debat/vote/finished) keep placeholders until
// their scene banners are produced.
export const PHASE_ASSET: Record<Phase, { audio: string; image: string }> = {
  lobby: { audio: "introduction", image: "scene_menu" },
  roles: { audio: "introduction", image: "scene_menu" },
  zazavavindrano: { audio: "cupidon", image: "power_zaza_fady" },
  mpamosavy: { audio: "sorciere", image: "power_mpamosavy_malediction" },
  mpisikidy: { audio: "voyante", image: "power_mpisikidy_sikidy" },
  kalanoro: { audio: "voyante", image: "power_kalanoro_traces" },
  songomby: { audio: "loupgarou", image: "power_songomby_chasse" },
  ombiasy: { audio: "sorciere", image: "power_ombiasy_remede" },
  aube: { audio: "aube", image: "scene_aube" },
  debat: { audio: "debat", image: "scene_debat" },
  vote: { audio: "vote", image: "scene_vote" },
  finished: { audio: "revelation", image: "scene_victory_village" },
};

export const DEBATE_MS = 90_000;
export const NIGHT_STEP_MS = 30_000;
export const VOTE_MS = 45_000;
