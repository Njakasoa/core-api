import type { WSContext } from "hono/ws";
import type { Question } from "./questions.ts";
import { getTheme } from "./themes.ts";
import {
  GOAL_CASES,
  QUESTION_MS,
  REVEAL_MS,
  COOP_PERFECT_BONUS,
  COOP_MAX_Q,
  type MatchMode,
  type MatchPhase,
  type PlayerView,
  type QuizServerMsg,
  type RankingEntry,
} from "./protocol.ts";

type Socket = WSContext<unknown>;

interface Player {
  id: string;
  name: string;
  ws: Socket;
  pos: number;
  streak: number;
  answer?: number;   // choice index for the current question
  answeredAt?: number;
}

function safeSend(ws: Socket, msg: QuizServerMsg) {
  try { ws.send(JSON.stringify(msg)); } catch { /* socket gone */ }
}

/**
 * One quiz match. Server-authoritative: it owns the shuffled question order and
 * the answers, validates each `answer`, scores it, advances every player and
 * decides when the race is won. Clients only ever receive prompts and (after the
 * round) reveals — never the answer key up front.
 */
export class QuizRoom {
  readonly code: string;
  hostId: string;
  phase: MatchPhase = "lobby";
  mode: MatchMode = "classic";
  private players = new Map<string, Player>(); // by userId
  private order: Question[] = [];
  private qIndex = 0;
  private current?: { q: Question; startedAt: number };
  private timer?: ReturnType<typeof setTimeout>;
  /** Called when the last player leaves so the manager can drop the room. */
  onEmpty?: () => void;

  constructor(code: string, hostId: string) {
    this.code = code;
    this.hostId = hostId;
  }

  // ── membership ──
  /** Join (or reconnect). The name comes in via the connect URL, so there's no
   *  race with an async onOpen the way an immediate `hello` message would have. */
  join(id: string, ws: Socket, name: string) {
    const clean = name.slice(0, 16) || "Joueur";
    const existing = this.players.get(id);
    if (existing) { existing.ws = ws; existing.name = clean; } // reconnect: keep progress
    else {
      this.players.set(id, { id, name: clean, ws, pos: 0, streak: 0 });
      if (!this.players.has(this.hostId)) this.hostId = id;
    }
    this.broadcastRoster();
  }

  setName(id: string, name: string) {
    const p = this.players.get(id);
    if (p) p.name = name.slice(0, 16) || "Joueur";
    this.broadcastRoster();
  }

  leave(id: string) {
    this.players.delete(id);
    if (this.players.size === 0) { this.clearTimer(); this.onEmpty?.(); return; }
    if (id === this.hostId) this.hostId = this.players.keys().next().value!; // promote someone
    this.broadcastRoster();
  }

  has(id: string) { return this.players.has(id); }
  get size() { return this.players.size; }

  // ── match flow ──
  setMode(byUserId: string, mode: MatchMode) {
    if (byUserId !== this.hostId || this.phase !== "lobby") return;
    if (mode !== "classic" && mode !== "coop") return;
    this.mode = mode;
    this.broadcastRoster();
  }

  /** Host, after a match: reset everyone and return the whole room to the lobby. */
  rematch(byUserId: string) {
    if (byUserId !== this.hostId || this.phase !== "finished") return;
    this.clearTimer();
    this.order = []; this.qIndex = 0; this.current = undefined;
    for (const p of this.players.values()) { p.pos = 0; p.streak = 0; p.answer = undefined; p.answeredAt = undefined; }
    this.phase = "lobby";
    this.broadcastRoster();
  }

  start(byUserId: string, themeId: string) {
    if (byUserId !== this.hostId || this.phase !== "lobby") return;
    const theme = getTheme(themeId);
    if (!theme || theme.questions.length === 0) {
      safeSend(this.players.get(byUserId)!.ws, { k: "error", message: "Thème introuvable" });
      return;
    }
    this.order = shuffle(theme.questions);
    this.qIndex = 0;
    for (const p of this.players.values()) { p.pos = 0; p.streak = 0; }
    this.askQuestion();
  }

  answer(id: string, questionId: string, choiceIndex: number) {
    if (this.phase !== "question" || !this.current) return;
    if (this.current.q.id !== questionId) return; // stale answer
    const p = this.players.get(id);
    if (!p || p.answer !== undefined) return; // not joined / already answered
    p.answer = choiceIndex;
    p.answeredAt = Date.now();
    // Everyone answered → reveal early.
    if ([...this.players.values()].every((pl) => pl.answer !== undefined)) {
      this.clearTimer();
      this.reveal();
    } else {
      this.broadcast({ k: "state", phase: this.phase, players: this.views() });
    }
  }

  private askQuestion() {
    const q = this.order[this.qIndex]!;
    for (const p of this.players.values()) { p.answer = undefined; p.answeredAt = undefined; }
    this.current = { q, startedAt: Date.now() };
    this.phase = "question";
    this.broadcast({
      k: "question",
      questionId: q.id,
      index: this.qIndex + 1,
      total: this.order.length,
      prompt: q.prompt,
      choices: q.choices,
      durationMs: QUESTION_MS,
      startedAt: this.current.startedAt,
    });
    this.timer = setTimeout(() => this.reveal(), QUESTION_MS);
  }

  private reveal() {
    if (!this.current) return;
    const { q, startedAt } = this.current;
    const players = [...this.players.values()];

    // base per-player scoring (identical in both modes)
    let correctCount = 0;
    for (const p of players) {
      const correct = p.answer === q.answerIndex;
      let gained = 0;
      if (correct) {
        correctCount++;
        const dt = (p.answeredAt ?? startedAt) - startedAt;
        gained = dt < 5_000 ? 3 : dt < 10_000 ? 2 : 1;
        p.streak += 1;
        if (p.streak % 3 === 0) gained += 1; // streak bonus
      } else {
        p.streak = 0;
      }
      p.pos = Math.min(GOAL_CASES, p.pos + gained);
    }

    // coop "entraide": the group pulls the straggler, and a perfect round boosts all
    let coop: { perfect: boolean; helped?: string } | undefined;
    if (this.mode === "coop") {
      let helped: string | undefined;
      if (correctCount > 0) {
        const minPos = Math.min(...players.map((p) => p.pos));
        const laggards = players.filter((p) => p.pos === minPos && p.pos < GOAL_CASES);
        for (const p of laggards) p.pos = Math.min(GOAL_CASES, p.pos + correctCount); // +1 per correct teammate
        helped = laggards[0]?.name;
      }
      const perfect = players.length > 0 && correctCount === players.length;
      if (perfect) for (const p of players) p.pos = Math.min(GOAL_CASES, p.pos + COOP_PERFECT_BONUS);
      coop = { perfect, helped };
    }

    this.phase = "reveal";
    this.broadcast({
      k: "reveal",
      questionId: q.id,
      answerIndex: q.answerIndex,
      explanation: q.explanation,
      players: this.views(),
      coop,
    });

    const last = this.qIndex + 1 >= this.order.length;
    const end = this.mode === "coop"
      ? players.every((p) => p.pos >= GOAL_CASES) || this.qIndex + 1 >= COOP_MAX_Q || last
      : players.some((p) => p.pos >= GOAL_CASES) || last;
    this.timer = setTimeout(() => {
      if (end) this.finish();
      else { this.qIndex += 1; this.askQuestion(); }
    }, REVEAL_MS);
  }

  private finish() {
    this.phase = "finished";
    const players = [...this.players.values()];
    const ranking: RankingEntry[] = [...players]
      .sort((a, b) => b.pos - a.pos)
      .map((p, i) => ({ rank: i + 1, id: p.id, name: p.name, pos: p.pos }));
    const coop = this.mode === "coop"
      ? (() => {
          const arrived = players.filter((p) => p.pos >= GOAL_CASES).length;
          return { allFinished: arrived === players.length, arrived, total: players.length };
        })()
      : undefined;
    this.broadcast({ k: "finish", mode: this.mode, ranking, coop });
  }

  // ── helpers ──
  /** Send the right "where are we" message to a single (re)joining socket. */
  sendSnapshot(id: string) {
    const p = this.players.get(id);
    if (!p) return;
    safeSend(p.ws, { k: "lobby", code: this.code, hostId: this.hostId, selfId: id, mode: this.mode, players: this.views() });
    if (this.phase !== "lobby") safeSend(p.ws, { k: "state", phase: this.phase, players: this.views() });
  }

  /** Re-send the roster: a fresh `lobby` to each player while waiting, or a
   *  `state` once the match is running. */
  broadcastRoster() {
    if (this.phase === "lobby") {
      for (const p of this.players.values()) {
        safeSend(p.ws, { k: "lobby", code: this.code, hostId: this.hostId, selfId: p.id, mode: this.mode, players: this.views() });
      }
    } else {
      this.broadcast({ k: "state", phase: this.phase, players: this.views() });
    }
  }

  private broadcast(msg: QuizServerMsg) {
    for (const p of this.players.values()) safeSend(p.ws, msg);
  }

  private views(): PlayerView[] {
    return [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, pos: p.pos, streak: p.streak, answered: p.answer !== undefined,
    }));
  }

  private clearTimer() { if (this.timer) { clearTimeout(this.timer); this.timer = undefined; } }
}

/** Fisher–Yates copy. */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
