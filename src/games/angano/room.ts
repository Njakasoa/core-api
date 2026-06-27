import type { WSContext } from "hono/ws";
import { ROLES, roleName, roleTeam, isPackKiller, type Team } from "./roles.ts";
import {
  PHASE_ASSET, PACE_MS, NIGHT_STEP_MS,
  type Phase, type GameConfig, type PlayerPublic, type NarratorPlayer, type AnganoServerMsg,
} from "./protocol.ts";

type Socket = WSContext<unknown>;

interface Player {
  id: string;
  name: string;
  ws: Socket;
  alive: boolean;
  connected: boolean;
  isNarrator: boolean;
  roleId?: string;
  healUsed?: boolean;
  poisonUsed?: boolean;
}

function safeSend(ws: Socket, msg: AnganoServerMsg) {
  try { ws.send(JSON.stringify(msg)); } catch { /* gone */ }
}

// Preset "Fady & Traces" by default (see docs/roles-folklore-finalise-v2.md).
const DEFAULT_CONFIG: GameConfig = { songomby: 1, roles: ["mpisikidy", "ombiasy", "mpihaza", "zazavavindrano", "kalanoro"] };
const MIN_PLAYERS = 4; // role-bearing players (excl. narrator)
const AUBE_PAUSE_MS = 2500; // let the death reveal land before day/night resumes

// human-readable phase labels for the public banner
const PHASE_LABEL: Partial<Record<Phase, string>> = {
  zazavavindrano: "Zazavavindrano", mpamosavy: "Mpamosavy", mpisikidy: "Mpisikidy",
  kalanoro: "Kalanoro", songomby: "Songomby", ombiasy: "Ombiasy",
};

/**
 * One Angano match. Fully server-authoritative. V2 night model: each role only
 * *collects* a choice during its step; the night is then resolved at dawn in a
 * fixed order (marks → blocks → info → kills → saves → traces), so a roleblock
 * (Mpamosavy) can cancel info/support, a fady (Zazavavindrano) can sense hostile
 * visits, and a tracker (Kalanoro) can tell whether its target moved. Secret info
 * is sent only to the entitled socket(s).
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
  private wolfVotes = new Map<string, string>(); // packMemberId -> targetId
  private nightVictim: string | null = null;
  private nightHealed = false;
  private nightPoison: string | null = null;
  // collected single-target night choices
  private zazaTarget: string | null = null;
  private mpamosavyTarget: string | null = null;
  private seerTarget: string | null = null;
  private kalanoroTarget: string | null = null;
  private usedHealThisNight = false;
  private usedPoisonThisNight = false;
  // "no repeat" memory for fady / curse
  private lastZazaTarget: string | null = null;
  private lastMpamosavyTarget: string | null = null;
  // day vote
  private votes = new Map<string, string>(); // voterId -> targetId
  // death resolution
  private deathQueue: string[] = [];
  private deathReveals: { id: string; roleId: string; nameMg: string }[] = [];
  private pendingHunter: string | null = null;
  private afterDeaths: (() => void) | null = null;
  private lastPhase?: Extract<AnganoServerMsg, { k: "phase" }>; // for reconnect resync
  // pacing: single-shot advance, consumed by timeout / completed action / narrator
  private onAdvance: (() => void) | null = null;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(code: string, hostId: string) { this.code = code; this.hostId = hostId; }

  // ── membership ──
  join(id: string, ws: Socket, name: string) {
    const clean = name.slice(0, 16) || "Joueur";
    const ex = this.players.get(id);
    if (ex) { ex.ws = ws; ex.name = clean; ex.connected = true; } // reconnect: re-attach the socket
    else if (this.phase !== "lobby") {                // a brand-new player can't join a running game
      safeSend(ws, { k: "error", message: "Partie déjà en cours." });
      return;
    } else {
      this.players.set(id, { id, name: clean, ws, alive: true, connected: true, isNarrator: false });
      if (!this.players.has(this.hostId)) this.hostId = id;
    }
    if (this.phase === "lobby") this.broadcastLobby(); // mid-game: don't push everyone back to the lobby screen
    this.sendSelf(id);
  }
  /** Socket closed. In lobby → drop the seat; mid-game → keep the seat (their role &
   *  parity stay) but mark offline, so a reconnect with the same id can resume. */
  disconnect(id: string) {
    if (this.phase === "lobby") { this.leave(id); return; }
    const p = this.players.get(id);
    if (p) p.connected = false;
    if (![...this.players.values()].some((q) => q.connected)) { this.clearTimer(); this.onEmpty?.(); }
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
    for (const p of this.players.values()) p.isNarrator = p.id === this.narratorId;
    this.broadcastLobby();
  }
  setConfig(id: string, config: GameConfig) {
    if (id !== this.hostId || this.phase !== "lobby") return;
    const roles = [...new Set((config.roles ?? []).filter((r) => ROLES[r]?.optional))]; // dedupe
    const pace = (["rapide", "normal", "lent"] as const).includes(config.pace as never) ? config.pace : "normal";
    this.config = { songomby: Math.max(1, Math.min(5, Math.floor(config.songomby || 1))), roles, pace, manualDeaths: !!config.manualDeaths };
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
    const evilCount = pool.filter((r) => roleTeam(r) === "songomby").length;
    if (evilCount * 2 >= seats.length) return this.err(id, "Trop de rôles maléfiques (Songomby/Kinoly/Mpamosavy) pour le nombre de joueurs.");
    shuffle(pool);
    const shuffled = shuffle([...seats]);
    shuffled.forEach((p, i) => { p.roleId = pool[i]!; p.alive = true; p.healUsed = false; p.poisonUsed = false; });
    this.lastZazaTarget = null; this.lastMpamosavyTarget = null;
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
      case "zazavavindrano":
        if (p.roleId !== "zazavavindrano" || !targetId) return;
        this.zazaTarget = targetId; this.pushLog(`Zazavavindrano pose un fady d'eau sur ${this.name(targetId)}.`);
        this.fire();
        break;
      case "mpamosavy":
        if (p.roleId !== "mpamosavy" || !targetId) return;
        this.mpamosavyTarget = targetId; this.pushLog(`Mpamosavy maudit ${this.name(targetId)}.`);
        this.fire();
        break;
      case "mpisikidy":
        if (p.roleId !== "mpisikidy" || !targetId) return;
        this.seerTarget = targetId;
        this.fire();
        break;
      case "kalanoro":
        if (p.roleId !== "kalanoro" || !targetId) return;
        this.kalanoroTarget = targetId;
        this.fire();
        break;
      case "songomby":
        if (!isPackKiller(p.roleId) || !targetId) return;
        this.wolfVotes.set(id, targetId);
        this.sendWolves();
        if (this.alivePack().every((w) => this.wolfVotes.has(w.id))) this.fire();
        break;
      case "ombiasy":
        if (p.roleId !== "ombiasy") return;
        if (extra === "heal" && !p.healUsed) { this.nightHealed = true; p.healUsed = true; this.usedHealThisNight = true; this.pushLog("Ombiasy soigne la victime."); }
        else if (extra === "poison" && targetId && !p.poisonUsed) { this.nightPoison = targetId; p.poisonUsed = true; this.usedPoisonThisNight = true; this.pushLog(`Ombiasy empoisonne ${this.name(targetId)}.`); }
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
    if (this.aliveSeatPlayers().every((s) => this.votes.has(s.id))) this.fire();
  }
  nextPhase(id: string) { if (id === this.narratorId || id === this.hostId) this.fire(); }
  rematch(id: string) {
    if (id !== this.hostId || this.phase !== "finished") return;
    this.clearTimer();
    this.day = 0; this.phase = "lobby"; this.steps = []; this.stepIx = 0;
    this.wolfVotes.clear(); this.votes.clear(); this.deathQueue = []; this.deathReveals = []; this.pendingHunter = null;
    this.zazaTarget = this.mpamosavyTarget = this.seerTarget = this.kalanoroTarget = null;
    this.lastZazaTarget = this.lastMpamosavyTarget = null;
    for (const p of this.players.values()) { p.alive = true; p.roleId = undefined; p.healUsed = false; p.poisonUsed = false; }
    this.broadcastLobby();
  }

  // ── night machine ──
  private beginNight() {
    this.day += 1;
    this.nightVictim = null; this.nightHealed = false; this.nightPoison = null; this.wolfVotes.clear();
    this.zazaTarget = this.mpamosavyTarget = this.seerTarget = this.kalanoroTarget = null;
    this.usedHealThisNight = false; this.usedPoisonThisNight = false;
    this.steps = [];
    if (this.alivePlaying("zazavavindrano")) this.steps.push("zazavavindrano");
    if (this.alivePlaying("mpamosavy")) this.steps.push("mpamosavy");
    if (this.alivePlaying("mpisikidy")) this.steps.push("mpisikidy");
    if (this.alivePlaying("kalanoro")) this.steps.push("kalanoro");
    if (this.alivePack().length > 0) this.steps.push("songomby");
    if (this.alivePlaying("ombiasy")) this.steps.push("ombiasy");
    this.stepIx = 0;
    this.enterStep();
  }

  private enterStep() {
    if (this.stepIx >= this.steps.length) return this.resolveNight();
    const phase = this.steps[this.stepIx]!;
    this.setPhase(phase, `Nuit ${this.day} — ${PHASE_LABEL[phase] ?? phase}`, this.nightText(phase));
    const alive = this.aliveSeats();
    if (phase === "zazavavindrano") this.prompt("zazavavindrano", this.alivePlayers("zazavavindrano"), { targets: this.aliveExcept([this.firstAlive("zazavavindrano"), this.lastZazaTarget]) });
    else if (phase === "mpamosavy") this.prompt("mpamosavy", this.alivePlayers("mpamosavy"), { targets: this.aliveExcept([this.firstAlive("mpamosavy"), this.lastMpamosavyTarget]) });
    else if (phase === "mpisikidy") this.prompt("mpisikidy", this.alivePlayers("mpisikidy"), { targets: this.aliveExcept([this.firstAlive("mpisikidy")]) });
    else if (phase === "kalanoro") this.prompt("kalanoro", this.alivePlayers("kalanoro"), { targets: this.aliveExcept([this.firstAlive("kalanoro")]) });
    else if (phase === "songomby") { this.sendWolves(); this.prompt("songomby", this.alivePack(), { targets: alive.filter((t) => !isPackKiller(this.players.get(t.id)?.roleId)) }); }
    else if (phase === "ombiasy") {
      const witch = this.alivePlayers("ombiasy")[0];
      if (witch) safeSend(witch.ws, { k: "wolves", wolfIds: [], victimId: this.nightVictim });
      this.prompt("ombiasy", this.alivePlayers("ombiasy"), { targets: alive, options: ["heal", "poison", "skip"] });
    }
    this.arm(this.pace().night, () => this.finishStep());
  }
  private finishStep() {
    if (this.phase === "songomby") {
      this.nightVictim = pickMajority([...this.wolfVotes.values()]);
      if (this.nightVictim) this.pushLog(`Les Songomby dévorent ${this.name(this.nightVictim)}.`);
    }
    this.stepIx += 1;
    this.enterStep();
  }

  /** Resolve the collected night in the fixed order, then move to dawn deaths. */
  private resolveNight() {
    this.setPhase("aube", `Aube — Jour ${this.day}`, "Le village se réveille…");

    const blocked = new Set<string>();
    if (this.mpamosavyTarget) blocked.add(this.mpamosavyTarget);

    const zazaP = this.firstAlivePlayer("zazavavindrano");
    const mpamP = this.firstAlivePlayer("mpamosavy");
    const seerP = this.firstAlivePlayer("mpisikidy");
    const kalP = this.firstAlivePlayer("kalanoro");
    const ombP = this.firstAlivePlayer("ombiasy");

    const zazaBlocked = !!zazaP && blocked.has(zazaP.id);
    const seerBlocked = !!seerP && blocked.has(seerP.id);
    const kalBlocked = !!kalP && blocked.has(kalP.id);
    const ombBlocked = !!ombP && blocked.has(ombP.id);

    // record visits for successful (non-blocked) actions
    const visits: { actorId: string; targetId: string; hostile: boolean }[] = [];
    const visit = (actorId: string, targetId: string | null, hostile: boolean) => { if (targetId) visits.push({ actorId, targetId, hostile }); };
    if (zazaP && this.zazaTarget && !zazaBlocked) visit(zazaP.id, this.zazaTarget, false);
    if (mpamP && this.mpamosavyTarget) visit(mpamP.id, this.mpamosavyTarget, true); // curse is hostile, can't be self-blocked
    if (seerP && this.seerTarget && !seerBlocked) visit(seerP.id, this.seerTarget, false);
    if (kalP && this.kalanoroTarget && !kalBlocked) visit(kalP.id, this.kalanoroTarget, false);
    if (this.nightVictim) for (const w of this.alivePack()) visit(w.id, this.nightVictim, true); // pack kill is unblockable
    if (ombP && !ombBlocked) {
      if (this.nightHealed) visit(ombP.id, this.nightVictim, false);
      if (this.nightPoison) visit(ombP.id, this.nightPoison, true);
    }

    // a roleblocked witch loses her potion's effect — and gets the charge back
    if (ombBlocked && ombP) {
      if (this.usedHealThisNight) ombP.healUsed = false;
      if (this.usedPoisonThisNight) ombP.poisonUsed = false;
      this.nightHealed = false; this.nightPoison = null;
    }

    // deaths (saves already accounted for)
    const deaths: string[] = [];
    if (this.nightVictim && !this.nightHealed) deaths.push(this.nightVictim);
    if (this.nightPoison) deaths.push(this.nightPoison);

    // private dawn results
    if (seerP && this.seerTarget && !seerBlocked) this.sendSeer(seerP, this.seerTarget);
    if (kalP && this.kalanoroTarget && !kalBlocked) {
      const visited = visits.some((v) => v.actorId === this.kalanoroTarget);
      safeSend(kalP.ws, { k: "trackResult", targetId: this.kalanoroTarget, visited });
      this.pushLog(`Kalanoro piste ${this.name(this.kalanoroTarget)} → ${visited ? "a quitté sa place" : "immobile"}.`);
    }
    if (zazaP && this.zazaTarget && !zazaBlocked) {
      const troubled = visits.some((v) => v.targetId === this.zazaTarget && v.hostile);
      if (troubled) { safeSend(zazaP.ws, { k: "fadyTrace", targetId: this.zazaTarget }); this.pushLog(`Le fady d'eau sur ${this.name(this.zazaTarget)} a été troublé.`); }
    }
    // roleblock notifications (only to actors who actually tried to act)
    if (seerBlocked && this.seerTarget && seerP) safeSend(seerP.ws, { k: "blocked" });
    if (kalBlocked && this.kalanoroTarget && kalP) safeSend(kalP.ws, { k: "blocked" });
    if (zazaBlocked && this.zazaTarget && zazaP) safeSend(zazaP.ws, { k: "blocked" });
    if (ombBlocked && (this.usedHealThisNight || this.usedPoisonThisNight) && ombP) safeSend(ombP.ws, { k: "blocked" });

    this.lastZazaTarget = this.zazaTarget;
    this.lastMpamosavyTarget = this.mpamosavyTarget;

    this.beginDeaths(deaths, () => this.beginDay());
  }

  // ── death resolution (hunter chain) ──
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
      if (p.roleId === "mpihaza" && this.aliveSeats().length > 0) { this.pendingHunter = id; break; }
    }
    if (this.pendingHunter) {
      const hp = this.players.get(this.pendingHunter)!;
      this.setPhase("aube", "Le Mpihaza décoche sa flèche…", `${hp.name}, emporte un joueur avec toi.`);
      safeSend(hp.ws, { k: "prompt", kind: "mpihaza", targets: this.aliveSeats(), deadline: Date.now() + NIGHT_STEP_MS });
      this.sendNarrator();
      this.arm(this.pace().night, () => this.hunterShoot(null));
      return;
    }
    if (this.deathReveals.length) {
      this.broadcast({ k: "deaths", ids: this.deathReveals.map((r) => r.id), reveals: this.deathReveals, text: deathsText(this.deathReveals) });
    } else if (this.phase === "aube") {
      this.broadcast({ k: "deaths", ids: [], reveals: [], text: "Personne n'est mort cette nuit." });
    }
    this.sendNarrator();
    const after = this.afterDeaths; this.afterDeaths = null;
    if (this.checkWin()) return;
    if (after) this.arm(this.config.manualDeaths && this.narratorId ? 90_000 : AUBE_PAUSE_MS, after); // narrator-paced reveal, or a brief beat
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
    this.arm(this.pace().debate, () => this.beginVote());
  }
  private beginVote() {
    this.votes.clear();
    this.setPhase("vote", `Jour ${this.day} — Vote`, "Votez pour éliminer un suspect.");
    this.prompt("vote", this.aliveSeatPlayers(), { targets: this.aliveSeats() });
    this.arm(this.pace().vote, () => this.tallyVote());
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

  // ── win check (V2: village vs songomby parity, no lovers) ──
  private checkWin(): boolean {
    const alive = this.aliveSeatPlayers();
    const evil = alive.filter((p) => roleTeam(p.roleId ?? "") === "songomby");
    if (evil.length === 0) return this.finish("village");
    if (evil.length >= alive.length - evil.length) return this.finish("songomby");
    return false;
  }
  private finish(winner: Team): boolean {
    this.clearTimer();
    this.phase = "finished";
    const reveal = [...this.players.values()].filter((p) => p.id !== this.narratorId)
      .map((p) => ({ id: p.id, name: p.name, roleId: p.roleId ?? "mponina", nameMg: roleName(p.roleId ?? "mponina") }));
    const text = winner === "village"
      ? "Le village a chassé tous les monstres ! 🎉"
      : "Les Songomby ont fait taire le village… 🐺";
    this.broadcast({ k: "finish", winner, text, reveal });
    this.sendNarrator();
    return true;
  }

  // ── role powers (resolved at dawn) ──
  private sendSeer(seer: Player, targetId: string) {
    const t = this.players.get(targetId);
    if (!t) return;
    const shown = t.roleId === "kinoly" ? "mponina" : (t.roleId ?? "mponina"); // Kinoly disguise
    safeSend(seer.ws, { k: "seerResult", targetId, roleId: shown, nameMg: roleName(shown) });
    this.pushLog(`Le Mpisikidy sonde ${t.name} → ${roleName(shown)}.`);
  }

  // ── helpers ──
  private aliveSeats(): PlayerPublic[] { return this.aliveSeatPlayers().map(pub); }
  private aliveSeatPlayers(): Player[] { return [...this.players.values()].filter((p) => p.alive && p.id !== this.narratorId); }
  private aliveExcept(ids: (string | null | undefined)[]): PlayerPublic[] {
    const ex = new Set(ids.filter(Boolean) as string[]);
    return this.aliveSeats().filter((t) => !ex.has(t.id));
  }
  private alivePack(): Player[] { return [...this.players.values()].filter((p) => p.alive && isPackKiller(p.roleId)); }
  private alivePlayers(roleId: string): Player[] { return [...this.players.values()].filter((p) => p.alive && p.roleId === roleId); }
  private firstAlivePlayer(roleId: string): Player | undefined { return this.alivePlayers(roleId)[0]; }
  private alivePlaying(roleId: string): boolean { return this.alivePlayers(roleId).length > 0; }
  private firstAlive(roleId: string): string | undefined { return this.alivePlayers(roleId)[0]?.id; }
  private name(id: string): string { return this.players.get(id)?.name ?? "?"; }
  private pace() { return PACE_MS[this.config.pace ?? "normal"] ?? PACE_MS.normal; }
  private nightText(phase: Phase): string {
    return phase === "zazavavindrano" ? "Zazavavindrano pose un fady d'eau."
      : phase === "mpamosavy" ? "Le Mpamosavy souffle une malédiction."
      : phase === "mpisikidy" ? "Le Mpisikidy sonde un joueur."
      : phase === "kalanoro" ? "Le Kalanoro lit les pas de la nuit."
      : phase === "songomby" ? "Les Songomby choisissent leur victime."
      : phase === "ombiasy" ? "L'Ombiasy peut soigner ou empoisonner." : "La nuit tombe…";
  }

  private setPhase(phase: Phase, title: string, text: string) {
    this.phase = phase;
    const a = PHASE_ASSET[phase];
    const dur = phase === "debat" ? this.pace().debate : phase === "vote" ? this.pace().vote : this.pace().night;
    this.lastPhase = { k: "phase", phase, day: this.day, audioKey: a.audio, imageKey: a.image, durationMs: dur, title, text };
    this.broadcast(this.lastPhase);
    this.broadcast({ k: "state", phase, day: this.day, players: [...this.players.values()].map(pub) });
    this.sendNarrator();
  }
  private prompt(kind: string, to: Player[], opts: { targets: PlayerPublic[]; options?: string[] }) {
    for (const p of to) safeSend(p.ws, { k: "prompt", kind, targets: opts.targets, options: opts.options, deadline: Date.now() + NIGHT_STEP_MS });
  }
  private sendWolves() {
    const wolfIds = this.alivePack().map((w) => w.id);
    const victim = pickMajority([...this.wolfVotes.values()]);
    for (const w of this.alivePack()) safeSend(w.ws, { k: "wolves", wolfIds, victimId: victim });
  }
  private sendRole(p: Player) {
    const def = ROLES[p.roleId ?? "mponina"]!;
    safeSend(p.ws, { k: "role", role: { roleId: def.id, team: def.team, nameMg: def.nameMg, desc: def.desc } });
  }
  private sendSelf(id: string) {
    const p = this.players.get(id); if (!p) return;
    safeSend(p.ws, { k: "lobby", code: this.code, hostId: this.hostId, narratorId: this.narratorId, selfId: id, config: this.config, players: [...this.players.values()].map(pub) });
    if (this.phase !== "lobby" && p.roleId) this.sendRole(p);
    // reconnect resync: re-enter the stage at the current phase + state
    if (this.phase !== "lobby" && this.phase !== "finished" && this.lastPhase) {
      safeSend(p.ws, this.lastPhase);
      safeSend(p.ws, { k: "state", phase: this.phase, day: this.day, players: [...this.players.values()].map(pub) });
    }
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
      .map((p) => ({ ...pub(p), roleId: p.roleId }));
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
