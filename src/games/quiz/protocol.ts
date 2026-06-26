/**
 * Quiz Run wire protocol (server-authoritative). The server owns the questions,
 * validates answers and computes scores; the correct answer is only ever sent
 * in a `reveal`, never in `question`. The browser game mirrors these types.
 */

export type MatchPhase = "lobby" | "question" | "reveal" | "finished";

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
  | { k: "start"; themeId: string }                       // host only
  | { k: "answer"; questionId: string; choiceIndex: number };

/** Server → client. */
export type QuizServerMsg =
  | { k: "lobby"; code: string; hostId: string; selfId: string; players: PlayerView[] }
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
  | { k: "reveal"; questionId: string; answerIndex: number; explanation?: string; players: PlayerView[] }
  | { k: "state"; phase: MatchPhase; players: PlayerView[] }
  | { k: "finish"; ranking: RankingEntry[] }
  | { k: "error"; message: string };

/** Shared match constants. */
export const GOAL_CASES = 30;
export const QUESTION_MS = 15_000;
export const REVEAL_MS = 4_000;
