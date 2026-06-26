import type { WSContext } from "hono/ws";
import { ROLES, roleName, roleTeam, type Team } from "./roles.ts";
import {
  PHASE_ASSET, DEBATE_MS, NIGHT_STEP_MS, VOTE_MS,
  type Phase, type GameConfig, type PlayerPublic, type NarratorPlayer, type AnganoServerMsg,
} from "./protocol.ts";

type Socket = WSContext<unknown>;

interface Player {
  id: string;
  name: string;
  ws: Socket;
  alive: boolean;
  isNarrator: boolean;
  roleId?: string;
  loverId?: string;
  healUsed?: boolean;
  poisonUsed?: boolean;
}

function safeSend(ws: Socket, msg: AnganoServerMsg) {
  try { ws.send(JSON.stringify(msg)); } catch { /* gone */ }
}

const DEFAULT_CONFIG: GameConfig = { songomby: 1, roles: ["mpisikidy", "ombiasy", "cupidon"] };
const MIN_PLAYERS = 4; // role-bearing players (excl. narrator)

/**
 * One Angano match. Fully server-authoritative: it assigns secret roles, runs
 * the night step machine, resolves deaths (lovers + hunter chains), runs the day
 * vote and decides the winner. Secret info (role / seerResult / wolves / the
 * narrator god-view) is sent only to the entitled socket(s).
 */
export class AnganoRoom {
  readonly code: string;
  hostId: string;
  narratorId: string | null = null;
  phase: Phase = "lobby";
  day = 0;
  private config: GameConfig = { ...DEFAULT_CONFIG };
  private players = new Map<string, Player>();
  private log: string[] = [];
  onEmpty?: () => void;

  // night step machine
  private steps: Phase[] = [];
  private stepIx = 0;
  private wolfVotes = new Map<string, string>(); // wolfId -> targetId
  private nightVictim: string | null = null;
  private nightHealed = false;
  private nightPoison: string | null = null;
  // day vote
  private votes = new Map<string, string>(); // voterId -> targetId
  // death resolution
  private deathQueue: string[] = [];
  private deathReveals: { id: string; roleId: string; nameMg: string }[] = [];
  private pendingHunter: string | null = null;
  private afterDeaths: (() => void) | null = null;
  // pacing: single-shot advance, consumed by timeout / completed action / narrator
  private onAdvance: (() => void) | null = null;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(code: string, hostId: string) { this.code = code; this.hostId = hostId; }

  // ── membership ──
  join(id: string, ws: Socket, name: string) {
    const clean = name.slice(0, 16) || "Joueur";
    const ex = this.players.get(id);
    if (ex) { ex.ws = ws; ex.name = clean; }
    else {
      this.players.set(id, { id, name: clean, ws, alive: true, isNarrator: false });
      if (!this.players.has(this.hostId)) this.hostId = id;
    }
    this.broadcastLobby();
    this.sendSelf(id);
  }
  setName(id: string, name: string) { const p = this.players.get(id); if (p) p.name = name.slice(0, 16) || "Joueur"; this.broadcastLobby(); }
  leave(id: string) {
    this.players.delete(id);
    if (id === this.narratorId) this.narratorId = null;
    if (this.players.size === 0) { this.clearTimer(); this.onEmpty?.(); return; }
    if (id === this.hostId) this.hostId = this.players.keys().next().value!;
    this.broadcastLobby();
  }
  has(id: string) { return this.players.has(id); }
  get size() { return this.players.size; }

  // ── lobby config ──
  takeNarrator(id: string, on: boolean) {
    if (this.phase !== "lobby") return;
    if (on) { this.narratorId = id; const p = this.players.get(id); if (p) p.isNarrator = true; }
    else if (this.narratorId === id) { this.narratorId = null; const p = this.players.get(id); if (p) p.isNarrator = false; }
    // clear narrator flag on others
    for (const p of this.players.values()) p.isNarrator = p.id === this.narratorId;
    this.broadcastLobby();
  }
  setConfig(id: string, config: GameConfig) {
    if (id !== this.hostId || this.phase !== "lobby") return;
    const roles = (config.roles ?? []).filter((r) => ROLES[r]?.optional);
    this.config = { songomby: Math.max(1, Math.min(5, Math.floor(config.songomby || 1))), roles };
    this.broadcastLobby();
  }

  // ── start ──
  start(id: string) {
    if (id !== this.hostId || this.phase !== "lobby") return;
    const seats = [...this.players.values()].filter((p) => p.id !== this.narratorId);
    if (seats.length < MIN_PLAYERS) return this.err(id, `Il faut au moins ${MIN_PLAYERS} joueurs (hors narrateur).`);
    if (this.config.songomby >= seats.length) return this.err(id, "Trop de Songomby pour le nombre de joueurs.");

    // assign roles
    const pool: string[] = [];
    for (let i = 0; i < this.config.songomby; i++) pool.push("songomby");
    for (const r of this.config.roles) if (pool.length < seats.length) pool.push(r);
    while (pool.length < seats.length) pool.push("mponina");
    shuffle(pool);
    const shuffled = shuffle([...seats]);
    shuffled.forEach((p, i) => {
      p.roleId = pool[i]!; p.alive = true; p.loverId = undefined; p.healUsed = false; p.poisonUsed = false;
    });
    this.log = [];
    this.pushLog(`Partie lancée : ${seats.length} joueurs, ${this.config.songomby} Songomby.`);
    for (const p of seats) this.sendRole(p);
    this.sendNarrator();
    this.beginNight();
  }

  // ── client actions ──
  action(id: string, targetId: string | null, extra?: string) {
    const p = this.players.get(id);
    if (!p || !p.alive || p.id === this.narratorId) return;
    switch (this.phase) {
      case "cupidon":
        if (p.roleId !== "cupidon" || !targetId || !extra) return;
        this.linkLovers(targetId, extra);
        this.fire();
        break;
      case "mpisikidy":
        if (p.roleId !== "mpisikidy" || !targetId) return;
        this.seerInspect(p, targetId);
        this.fire();
        break;
      case "songomby":
        if (roleTeam(p.roleId ?? "") !== "songomby" || !targetId) return;
        this.wolfVotes.set(id, targetId);
        this.sendWolves();
        if (this.aliveWolves().every((w) => this.wolfVotes.has(w.id))) this.fire();
        break;
      case "ombiasy":
        if (p.roleId !== "ombiasy") return;
        if (extra === "heal" && !p.healUsed) { this.nightHealed = true; p.healUsed = true; this.pushLog(`Ombiasy soigne la victime.`); }
        else if (extra === "poison" && targetId && !p.poisonUsed) { this.nightPoison = targetId; p.poisonUsed = true; this.pushLog(`Ombiasy empoisonne ${this.name(targetId)}.`); }
        this.fire();
        break;
      case "aube":
        if (this.pendingHunter === id && p.roleId === "mpihaza") this.hunterShoot(targetId);
        break;
    }
  }
  vote(id: string, targetId: string | null) {
    if (this.phase !== "vote") return;
    const p = this.players.get(id);
    if (!p || !p.alive || p.id === this.narratorId) return;
    if (targetId && !this.players.get(targetId)?.alive) return;
    if (targetId) this.votes.set(id, targetId); else this.votes.delete(id);
    this.broadcast({ k: "voteState", tally: this.tally() });
    if (this.aliveSeats().every((s) => this.votes.has(s.id))) this.fire();
  }
  nextPhase(id: string) { if (id === this.narratorId || id === this.hostId) this.fire(); }
  rematch(id: string) {
    if (id !== this.hostId || this.phase !== "finished") return;
    this.clearTimer();
    this.day = 0; this.phase = "lobby"; this.steps = []; this.stepIx = 0;
    this.wolfVotes.clear(); this.votes.clear(); this.deathQueue = []; this.deathReveals = []; this.pendingHunter = null;
    for (const p of this.players.values()) { p.alive = true; p.roleId = undefined; p.loverId = undefined; p.healUsed = false; p.poisonUsed = false; }
    this.broadcastLobby();
  }

  // ── night machine ──
  private beginNight() {
    this.day += 1;
    this.nightVictim = null; this.nightHealed = false; this.nightPoison = null; this.wolfVotes.clear();
    this.steps = [];
    if (this.day === 1 && this.alivePlaying("cupidon")) this.steps.push("cupidon");
    if (this.alivePlaying("mpisikidy")) this.steps.push("mpisikidy");
    if (this.aliveWolves().length > 0) this.steps.push("songomby");
    if (this.alivePlaying("ombiasy")) this.steps.push("ombiasy");
    this.stepIx = 0;
    this.enterStep();
  }

  private enterStep() {
    if (this.stepIx >= this.steps.length) return this.resolveNight();
    const phase = this.steps[this.stepIx]!;
    const def = phase === "songomby" ? "Songomby" : phase[0]!.toUpperCase() + phase.slice(1);
    this.setPhase(phase, `Nuit ${this.day} — ${def}`, this.nightText(phase));
    // prompt the acting players
    const alive = this.aliveSeats();
    if (phase === "cupidon") this.prompt("cupidon", this.alivePlayers("cupidon"), { targets: alive });
    else if (phase === "mpisikidy") this.prompt("mpisikidy", this.alivePlayers("mpisikidy"), { targets: alive.filter((t) => t.id !== this.firstAlive("mpisikidy")) });
    else if (phase === "songomby") { this.sendWolves(); this.prompt("songomby", this.aliveWolves(), { targets: alive.filter((t) => roleTeam(this.players.get(t.id)!.roleId ?? "") !== "songomby") }); }
    else if (phase === "ombiasy") {
      const witch = this.alivePlayers("ombiasy")[0];
      if (witch) safeSend(witch.ws, { k: "wolves", wolfIds: [], victimId: this.nightHealed ? null : this.nightVictim });
      this.prompt("ombiasy", this.alivePlayers("ombiasy"), { targets: alive, options: ["heal", "poison", "skip"] });
    }
    this.arm(NIGHT_STEP_MS, () => this.finishStep());
  }
  private finishStep() {
    if (this.phase === "songomby") {
      this.nightVictim = pickMajority([...this.wolfVotes.values()]);
      if (this.nightVictim) this.pushLog(`Les Songomby dévorent ${this.name(this.nightVictim)}.`);
    }
    this.stepIx += 1;
    this.enterStep();
  }

  private resolveNight() {
    const ids: string[] = [];
    if (this.nightVictim && !this.nightHealed) ids.push(this.nightVictim);
    if (this.nightPoison) ids.push(this.nightPoison);
    this.setPhase("aube", `Aube — Jour ${this.day}`, "Le village se réveille…");
    this.beginDeaths(ids, () => this.beginDay());
  }

  // ── death resolution (lovers + hunter chains) ──
  private beginDeaths(ids: string[], after: () => void) {
    this.afterDeaths = after;
    this.deathReveals = [];
    this.deathQueue = [...ids];
    this.resolveDeaths();
  }
  private resolveDeaths() {
    while (this.deathQueue.length && !this.pendingHunter) {
      const id = this.deathQueue.shift()!;
      const p = this.players.get(id);
      if (!p || !p.alive) continue;
      p.alive = false;
      this.deathReveals.push({ id, roleId: p.roleId ?? "mponina", nameMg: roleName(p.roleId ?? "mponina") });
      this.pushLog(`${p.name} meurt (${roleName(p.roleId ?? "mponina")}).`);
      if (p.loverId) { const l = this.players.get(p.loverId); if (l?.alive) { this.deathQueue.push(l.id); this.pushLog(`${l.name} meurt de chagrin.`); } }
      if (p.roleId === "mpihaza" && this.aliveSeats().length > 0) { this.pendingHunter = id; break; }
    }
    if (this.pendingHunter) {
      const hp = this.players.get(this.pendingHunter)!;
      this.setPhase("aube", "Le Mpihaza décoche sa flèche…", `${hp.name}, emporte un joueur avec toi.`);
      safeSend(hp.ws, { k: "prompt", kind: "mpihaza", targets: this.aliveSeats(), deadline: Date.now() + NIGHT_STEP_MS });
      this.sendNarrator();
      this.arm(NIGHT_STEP_MS, () => this.hunterShoot(null));
      return;
    }
    // batch done
    if (this.deathReveals.length) {
      this.broadcast({ k: "deaths", ids: this.deathReveals.map((r) => r.id), reveals: this.deathReveals, text: deathsText(this.deathReveals) });
    } else if (this.phase === "aube") {
      this.broadcast({ k: "deaths", ids: [], reveals: [], text: "Personne n'est mort cette nuit." });
    }
    this.sendNarrator();
    const after = this.afterDeaths; this.afterDeaths = null;
    if (this.checkWin()) return;
    after?.();
  }
  private hunterShoot(targetId: string | null) {
    const hid = this.pendingHunter; if (!hid) return;
    this.pendingHunter = null;
    if (targetId && this.players.get(targetId)?.alive) { this.deathQueue.push(targetId); this.pushLog(`Le Mpihaza emporte ${this.name(targetId)}.`); }
    this.resolveDeaths();
  }

  // ── day ──
  private beginDay() {
    this.setPhase("debat", `Jour ${this.day} — Débat`, "Discutez, accusez, défendez-vous.");
    this.arm(DEBATE_MS, () => this.beginVote());
  }
  private beginVote() {
    this.votes.clear();
    this.setPhase("vote", `Jour ${this.day} — Vote`, "Votez pour éliminer un suspect.");
    this.prompt("vote", this.aliveSeatPlayers(), { targets: this.aliveSeats() });
    this.arm(VOTE_MS, () => this.tallyVote());
  }
  private tallyVote() {
    const counts = new Map<string, number>();
    for (const t of this.votes.values()) counts.set(t, (counts.get(t) ?? 0) + 1);
    let max = 0; for (const c of counts.values()) max = Math.max(max, c);
    const top = [...counts.entries()].filter(([, c]) => c === max).map(([id]) => id);
    const eliminated = max > 0 && top.length ? top[(Math.random() * top.length) | 0]! : null;
    this.broadcast({ k: "voteResult", eliminatedId: eliminated, ...(eliminated ? { roleId: this.players.get(eliminated)!.roleId, nameMg: roleName(this.players.get(eliminated)!.roleId ?? "mponina") } : {}) });
    if (eliminated) this.beginDeaths([eliminated], () => this.beginNight());
    else { this.pushLog("Personne n'est éliminé."); this.sendNarrator(); if (!this.checkWin()) this.beginNight(); }
  }

  // ── win check ──
  private checkWin(): boolean {
    const alive = this.aliveSeatPlayers();
    const wolves = alive.filter((p) => roleTeam(p.roleId ?? "") === "songomby");
    if (alive.length === 2 && alive[0]!.loverId === alive[1]!.id) return this.finish("lovers");
    if (wolves.length === 0) return this.finish("village");
    if (wolves.length >= alive.length - wolves.length) return this.finish("songomby");
    return false;
  }
  private finish(winner: Team | "lovers"): boolean {
    this.clearTimer();
    this.phase = "finished";
    const reveal = [...this.players.values()].filter((p) => p.id !== this.narratorId)
      .map((p) => ({ id: p.id, name: p.name, roleId: p.roleId ?? "mponina", nameMg: roleName(p.roleId ?? "mponina") }));
    const text = winner === "village" ? "Le village a éliminé tous les Songomby ! 🎉"
      : winner === "songomby" ? "Les Songomby dominent le village… 🐺"
      : "Les amoureux survivent ensemble, contre tous. 💕";
    this.broadcast({ k: "finish", winner, text, reveal });
    this.sendNarrator();
    return true;
  }

  // ── role powers ──
  private linkLovers(a: string, b: string) {
    const pa = this.players.get(a), pb = this.players.get(b);
    if (!pa || !pb || a === b) return;
    pa.loverId = b; pb.loverId = a;
    this.pushLog(`Cupidon lie ${pa.name} ❤ ${pb.name}.`);
    this.sendRole(pa); this.sendRole(pb);
  }
  private seerInspect(seer: Player, targetId: string) {
    const t = this.players.get(targetId);
    if (!t) return;
    safeSend(seer.ws, { k: "seerResult", targetId, roleId: t.roleId ?? "mponina", nameMg: roleName(t.roleId ?? "mponina") });
    this.pushLog(`Le Mpisikidy sonde ${t.name} → ${roleName(t.roleId ?? "mponina")}.`);
  }

  // ── helpers ──
  private aliveSeats(): PlayerPublic[] { return this.aliveSeatPlayers().map(pub); }
  private aliveSeatPlayers(): Player[] { return [...this.players.values()].filter((p) => p.alive && p.id !== this.narratorId); }
  private aliveWolves(): Player[] { return [...this.players.values()].filter((p) => p.alive && roleTeam(p.roleId ?? "") === "songomby"); }
  private alivePlayers(roleId: string): Player[] { return [...this.players.values()].filter((p) => p.alive && p.roleId === roleId); }
  private alivePlaying(roleId: string): boolean { return this.alivePlayers(roleId).length > 0; }
  private firstAlive(roleId: string): string | undefined { return this.alivePlayers(roleId)[0]?.id; }
  private name(id: string): string { return this.players.get(id)?.name ?? "?"; }
  private nightText(phase: Phase): string {
    return phase === "cupidon" ? "Cupidon désigne deux amoureux."
      : phase === "mpisikidy" ? "Le Mpisikidy sonde un joueur."
      : phase === "songomby" ? "Les Songomby choisissent leur victime."
      : phase === "ombiasy" ? "L'Ombiasy peut soigner ou empoisonner." : "La nuit tombe…";
  }

  private setPhase(phase: Phase, title: string, text: string) {
    this.phase = phase;
    const a = PHASE_ASSET[phase];
    const dur = phase === "debat" ? DEBATE_MS : phase === "vote" ? VOTE_MS : NIGHT_STEP_MS;
    this.broadcast({ k: "phase", phase, day: this.day, audioKey: a.audio, imageKey: a.image, durationMs: dur, title, text });
    this.broadcast({ k: "state", phase, day: this.day, players: [...this.players.values()].map(pub) });
    this.sendNarrator();
  }
  private prompt(kind: string, to: Player[], opts: { targets: PlayerPublic[]; options?: string[] }) {
    for (const p of to) safeSend(p.ws, { k: "prompt", kind, targets: opts.targets, options: opts.options, deadline: Date.now() + NIGHT_STEP_MS });
  }
  private sendWolves() {
    const wolfIds = this.aliveWolves().map((w) => w.id);
    const victim = pickMajority([...this.wolfVotes.values()]);
    for (const w of this.aliveWolves()) safeSend(w.ws, { k: "wolves", wolfIds, victimId: victim });
  }
  private sendRole(p: Player) {
    const def = ROLES[p.roleId ?? "mponina"]!;
    const lover = p.loverId ? this.players.get(p.loverId) : undefined;
    safeSend(p.ws, { k: "role", role: { roleId: def.id, team: def.team, nameMg: def.nameMg, desc: def.desc, loverId: lover?.id, loverName: lover?.name } });
  }
  private sendSelf(id: string) {
    const p = this.players.get(id); if (!p) return;
    safeSend(p.ws, { k: "lobby", code: this.code, hostId: this.hostId, narratorId: this.narratorId, selfId: id, config: this.config, players: [...this.players.values()].map(pub) });
    if (this.phase !== "lobby" && p.roleId) this.sendRole(p);
    if (this.phase !== "lobby" && id === this.narratorId) this.sendNarrator();
  }
  private broadcastLobby() {
    for (const p of this.players.values())
      safeSend(p.ws, { k: "lobby", code: this.code, hostId: this.hostId, narratorId: this.narratorId, selfId: p.id, config: this.config, players: [...this.players.values()].map(pub) });
  }
  private sendNarrator() {
    if (!this.narratorId) return;
    const nar = this.players.get(this.narratorId); if (!nar) return;
    const players: NarratorPlayer[] = [...this.players.values()].filter((p) => p.id !== this.narratorId)
      .map((p) => ({ ...pub(p), roleId: p.roleId, loverId: p.loverId }));
    safeSend(nar.ws, { k: "narrator", players, log: this.log.slice(-30) });
  }
  private tally() { const c = new Map<string, number>(); for (const t of this.votes.values()) c.set(t, (c.get(t) ?? 0) + 1); return [...c.entries()].map(([id, votes]) => ({ id, votes })); }
  private broadcast(msg: AnganoServerMsg) { for (const p of this.players.values()) safeSend(p.ws, msg); }
  private err(id: string, message: string) { const p = this.players.get(id); if (p) safeSend(p.ws, { k: "error", message }); }
  private pushLog(s: string) { this.log.push(s); }

  // pacing: single-shot advance consumed by timeout / completed action / narrator
  private arm(ms: number, fn: () => void) { this.clearTimer(); this.onAdvance = fn; this.timer = setTimeout(() => this.fire(), ms); }
  private fire() { const fn = this.onAdvance; this.onAdvance = null; this.clearTimer(); fn?.(); }
  private clearTimer() { if (this.timer) { clearTimeout(this.timer); this.timer = undefined; } }
}

function pub(p: Player): PlayerPublic { return { id: p.id, name: p.name, alive: p.alive, isNarrator: p.isNarrator }; }
function deathsText(reveals: { nameMg: string; id: string }[]): string {
  return reveals.length === 0 ? "Personne n'est mort." : `Mort(s) : ${reveals.length}.`;
}
function pickMajority(votes: string[]): string | null {
  if (!votes.length) return null;
  const c = new Map<string, number>();
  for (const v of votes) c.set(v, (c.get(v) ?? 0) + 1);
  let max = 0; for (const n of c.values()) max = Math.max(max, n);
  const top = [...c.entries()].filter(([, n]) => n === max).map(([id]) => id);
  return top[(Math.random() * top.length) | 0]!;
}
function shuffle<T>(a: T[]): T[] { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j]!, a[i]!]; } return a; }
