/**
 * Quiz Run wire protocol (server-authoritative). The server owns the questions,
 * validates answers and computes scores; the correct answer is only ever sent
 * in a `reveal`, never in `question`. The browser game mirrors these types.
 */

export type MatchPhase = "lobby" | "question" | "reveal" | "finished";
export type MatchMode = "classic" | "coop";

/** What every client is allowed to see about a player. */
export interface PlayerView {
  id: string;
  name: string;
  pos: number;      // race position, in cases (0..GOAL)
  streak: number;   // consecutive correct answers
  answered: boolean; // has answered the current question
}

export interface RankingEntry {
  rank: number;
  id: string;
  name: string;
  pos: number;
}

/** Client → server. */
export type QuizClientMsg =
  | { k: "hello"; name: string }
  | { k: "setMode"; mode: MatchMode }                      // host, in lobby
  | { k: "start"; themeId: string }                       // host only
  | { k: "answer"; questionId: string; choiceIndex: number }
  | { k: "rematch" };                                     // host, after finish → back to lobby

/** Server → client. */
export type QuizServerMsg =
  | { k: "lobby"; code: string; hostId: string; selfId: string; mode: MatchMode; players: PlayerView[] }
  | {
      k: "question";
      questionId: string;
      index: number;        // 1-based
      total: number;
      prompt: string;
      choices: string[];
      durationMs: number;
      startedAt: number;    // server epoch ms
    }
  | { k: "reveal"; questionId: string; answerIndex: number; explanation?: string; players: PlayerView[]; coop?: CoopReveal }
  | { k: "state"; phase: MatchPhase; players: PlayerView[] }
  | { k: "finish"; mode: MatchMode; ranking: RankingEntry[]; coop?: CoopResult }
  | { k: "error"; message: string };

/** Coop "entraide" feedback for a round / the match. */
export interface CoopReveal { perfect: boolean; helped?: string } // perfect round; id pulled by the team
export interface CoopResult { allFinished: boolean; arrived: number; total: number }

/** Shared match constants. */
export const GOAL_CASES = 30;
export const QUESTION_MS = 15_000;
export const REVEAL_MS = 4_000;
export const COOP_PERFECT_BONUS = 2;  // cases for everyone on a perfect round
export const COOP_MAX_Q = 25;         // safety cap so a coop match can't drag forever
