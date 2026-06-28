import type { WSContext } from "hono/ws";
import { ROLES, roleName, roleTeam, isPackKiller, type Team } from "./roles.ts";
import {
  PHASE_ASSET, PACE_MS, NIGHT_STEP_MS,
  type Phase, type GameConfig, type PlayerPublic, type NarratorPlayer, type AnganoServerMsg,
  type MissionStatus, type PlayerMissionSheet, type NarratorMissionSheet, type PersonalWinner,
} from "./protocol.ts";
import { generateStory, NIGHT_STORY_PHASES, type NightStoryPhase, type StorySetup } from "./story.ts";
import { buildMissionSheets } from "./missions.ts";
import { setRewardStatus, useUnlockedReward } from "./rewards.ts";

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
  exileUsed?: boolean;
}

type WaterOfferingCancel =
  | { kind: "mpamosavy"; actorId: string; targetId: string }
  | { kind: "kinoly"; actorId: string; targetId: string }
  | { kind: "songomby"; targetId: string }
  | { kind: "ombiasy"; actorId: string; targetId: string };

function safeSend(ws: Socket, msg: AnganoServerMsg) {
  try { ws.send(JSON.stringify(msg)); } catch { /* gone */ }
}

// Preset "Fady & Traces" by default (see docs/roles-folklore-finalise-v2.md).
const DEFAULT_CONFIG: GameConfig = { songomby: 1, roles: ["mpisikidy", "ombiasy", "fanany", "zazavavindrano", "kalanoro"] };
const MIN_PLAYERS = 4; // role-bearing players (excl. narrator)
const AUBE_PAUSE_MS = 2500; // let the death reveal land before day/night resumes

// human-readable phase labels for the public banner
const PHASE_LABEL: Partial<Record<Phase, string>> = {
  zazavavindrano: "Zazavavindrano", mpamosavy: "Mpamosavy", mpisikidy: "Mpisikidy",
  kalanoro: "Kalanoro", kinoly: "Kinoly", songomby: "Songomby", ombiasy: "Ombiasy",
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
  private story: StorySetup | null = null; // AI story legend for this game (null = classic)
  private missions = new Map<string, PlayerMissionSheet>();
  private players = new Map<string, Player>();
  private log: string[] = [];
  onEmpty?: () => void;

  // night step machine
  private steps: Phase[] = [];
  private stepIx = 0;
  private wolfVotes = new Map<string, string>(); // packMemberId -> targetId
  private nightVictim: string | null = null;
  private nightHealed = false;
  private nightExile: string | null = null;
  // collected single-target night choices
  private zazaTarget: string | null = null;
  private mpamosavyTarget: string | null = null;
  private seerTarget: string | null = null;
  private kalanoroTarget: string | null = null;
  private kinolyTargets = new Map<string, string>(); // kinolyId -> targetId chosen this night
  private kinolyHaunts = new Map<string, Set<string>>(); // kinolyId -> targets successfully haunted
  private kinolyAwakened = new Set<string>(); // dormant Kinoly unlock their power only after surviving a night death
  private kinolyObjectiveDone = new Set<string>(); // kinoly player ids
  private usedHealThisNight = false;
  private usedExileThisNight = false;
  // "no repeat" memory for fady / curse
  private lastZazaTarget: string | null = null;
  private lastMpamosavyTarget: string | null = null;
  private lastKalanoroTarget: string | null = null;
  // day vote
  private votes = new Map<string, string>(); // voterId -> targetId
  private fananyMark: string | null = null;
  private fananyMarkDay = 0;
  private songombyLayTarget: string | null = null;
  // death resolution
  private deathQueue: string[] = [];
  private deathReveals: { id: string; name: string; roleId: string; nameMg: string }[] = [];
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
    this.config = { songomby: Math.max(1, Math.min(5, Math.floor(config.songomby || 1))), roles, pace, manualDeaths: !!config.manualDeaths, theme: !!config.theme };
    this.broadcastLobby();
  }

  // ── start ──
  async start(id: string) {
    if (id !== this.hostId || this.phase !== "lobby") return;
    if (!this.narratorId) return this.err(id, "Il faut choisir un narrateur avant de lancer la partie.");
    const seats = [...this.players.values()].filter((p) => p.id !== this.narratorId);
    if (seats.length < MIN_PLAYERS) return this.err(id, `Il faut au moins ${MIN_PLAYERS} joueurs${this.narratorId ? " (hors narrateur)" : ""}.`);

    // optional AI story: show a prep screen, generate (bounded by a timeout), then
    // apply only the parts that keep the composition valid. Never blocks the game.
    this.story = null;
    if (this.config.theme) {
      this.phase = "roles";
      this.broadcast({ k: "phase", phase: "roles", day: 0, audioKey: PHASE_ASSET.roles.audio, imageKey: PHASE_ASSET.roles.image, durationMs: 30_000, title: "La légende se tisse…", text: "Les esprits du récit s'assemblent." });
      const story = await generateStory(seats.length, this.config);
      if (this.phase !== "roles") return; // room torn down / rematch during generation
      this.story = story;
      this.applyStoryConfig(story, seats.length);
    }

    if (!this.assignRoles(seats, id)) { this.phase = "lobby"; this.broadcastLobby(); return; }
    this.lastZazaTarget = null; this.lastMpamosavyTarget = null; this.lastKalanoroTarget = null;
    this.fananyMark = null; this.fananyMarkDay = 0; this.songombyLayTarget = null;
    this.kinolyTargets.clear(); this.kinolyHaunts.clear(); this.kinolyAwakened.clear(); this.kinolyObjectiveDone.clear();
    this.missions = this.config.theme ? buildMissionSheets(seats, this.story) : new Map();
    this.log = [];
    this.pushLog(`Partie lancée : ${seats.length} joueurs, ${this.config.songomby} Songomby.`);
    for (const p of seats) { this.sendRole(p); this.sendMission(p); }
    if (this.story) this.broadcast(this.storyMsg(this.story));
    this.sendNarrator();
    this.beginNight();
  }

  // role pool helpers (shared by composition validation + assignment)
  private buildPool(cfg: GameConfig, seatCount: number): string[] {
    const pool: string[] = [];
    for (let i = 0; i < cfg.songomby; i++) pool.push("songomby");
    for (const r of cfg.roles) if (pool.length < seatCount) pool.push(r);
    while (pool.length < seatCount) pool.push("mponina");
    return pool;
  }
  private compositionValid(cfg: GameConfig, seatCount: number): boolean {
    if (cfg.songomby >= seatCount) return false;
    const evil = this.buildPool(cfg, seatCount).filter((r) => roleTeam(r) === "songomby").length;
    return evil * 2 < seatCount;
  }
  /** Override roles/songomby/pace from the AI story — only if the result stays valid. */
  private applyStoryConfig(story: StorySetup, seatCount: number) {
    const c = story.config; if (!c) return;
    const cand: GameConfig = { ...this.config };
    if (c.roles) cand.roles = [...new Set(c.roles.filter((r) => ROLES[r]?.optional))];
    if (c.songomby) cand.songomby = Math.max(1, Math.min(5, Math.floor(c.songomby)));
    if (c.pace) cand.pace = c.pace;
    if (this.compositionValid(cand, seatCount)) this.config = cand;
  }
  private assignRoles(seats: Player[], id: string): boolean {
    if (!this.compositionValid(this.config, seats.length)) {
      this.err(id, "Composition invalide (trop de rôles maléfiques pour le nombre de joueurs).");
      return false;
    }
    const pool = shuffle(this.buildPool(this.config, seats.length));
    shuffle([...seats]).forEach((p, i) => { p.roleId = pool[i]!; p.alive = true; p.healUsed = false; p.exileUsed = false; });
    return true;
  }
  private storyMsg(s: StorySetup): AnganoServerMsg {
    return {
      k: "story",
      title: s.title,
      villageName: s.villageName,
      intro: s.intro,
      ambiance: s.ambiance,
      roleEpithets: s.roleEpithets,
      composition: { songomby: this.config.songomby, roles: this.config.roles, pace: this.config.pace ?? "normal" },
      narratorScript: s.narratorScript,
    };
  }

  // ── client actions ──
  action(id: string, targetId: string | null, extra?: string) {
    const p = this.players.get(id);
    if (!p || !p.alive || p.id === this.narratorId) return;
    switch (this.phase) {
      case "zazavavindrano":
        if (p.roleId !== "zazavavindrano" || !targetId || targetId === id || !this.players.get(targetId)?.alive) return;
        this.zazaTarget = targetId; this.pushLog(`Zazavavindrano lie ${this.name(targetId)} au Fady des eaux.`);
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
      case "kinoly":
        if (p.roleId !== "kinoly" || !this.kinolyAwakened.has(id) || !targetId) return;
        this.kinolyTargets.set(id, targetId);
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
        else if (extra === "exile" && targetId && !p.exileUsed) {
          this.nightExile = targetId;
          p.exileUsed = true;
          this.usedExileThisNight = true;
          this.pushLog(`Ombiasy accomplit un rituel d'exil contre ${this.name(targetId)}.`);
        }
        this.fire();
        break;
      case "debat":
        if (p.roleId !== "fanany" || !targetId || targetId === id || !this.players.get(targetId)?.alive) return;
        if (this.fananyMarkDay === this.day) return;
        this.fananyMark = targetId;
        this.fananyMarkDay = this.day;
        this.pushLog(`Fanany pose une Marque funeste sur ${this.name(targetId)}.`);
        this.sendNarrator();
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
  // Player asks the narrator to review their own mission (self-only: id is the connection's user).
  requestMissionReview(id: string) {
    if (this.phase === "lobby" || id === this.narratorId) return;
    const player = this.players.get(id);
    if (!player) return;
    if (player.roleId === "kinoly" && !this.kinolyAwakened.has(id)) return;
    const sheet = this.missions.get(id);
    if (!sheet || sheet.status !== "pending") return; // already requested/validated/failed → narrator must reopen
    sheet.status = "requested";
    sheet.reviewRejected = false;
    this.pushLog(`Demande de validation envoyée par ${player.name}.`);
    this.sendMission(player);
    this.sendNarrator();
  }
  missionStatus(id: string, playerId: string, status: MissionStatus) {
    if (id !== this.narratorId || this.phase === "lobby") return;
    const player = this.players.get(playerId);
    if (player?.roleId === "kinoly" && !this.kinolyAwakened.has(playerId)) return;
    const sheet = this.missions.get(playerId);
    if (!sheet) return;
    // A return-to-pending from a request is a refusal (leaves a visual trace); from validated/failed it's a reopen.
    sheet.reviewRejected = status === "pending" && sheet.status === "requested";
    const beforeRewards = new Map(sheet.rewards.map((reward) => [reward.id, reward.status]));
    this.applyMissionStatus(sheet, status);
    const label = status === "validated" ? "validée" : status === "failed" ? "ratée" : sheet.reviewRejected ? "refusée" : "rouverte";
    this.pushLog(`Mission de ${this.name(playerId)} ${label}.`);
    if (status === "validated") this.pushLog(`${this.name(playerId)} obtient le titre « ${sheet.titleReward} » (${sheet.titlesEarned} titre${sheet.titlesEarned > 1 ? "s" : ""}).`);
    const unlocked = sheet.rewards.filter((reward) => beforeRewards.get(reward.id) === "locked" && reward.status === "unlocked");
    if (unlocked.length) this.pushLog(`${this.name(playerId)} débloque ${unlocked.map((reward) => reward.name).join(", ")}.`);
    if (player) this.sendMission(player);
    this.sendNarrator();
  }
  nextPhase(id: string) { if (id === this.narratorId || id === this.hostId) this.fire(); }
  rematch(id: string) {
    if (id !== this.hostId || this.phase !== "finished") return;
    this.clearTimer();
    this.day = 0; this.phase = "lobby"; this.steps = []; this.stepIx = 0;
    this.wolfVotes.clear(); this.votes.clear(); this.deathQueue = []; this.deathReveals = [];
    this.fananyMark = null; this.fananyMarkDay = 0; this.songombyLayTarget = null;
    this.kinolyTargets.clear(); this.kinolyHaunts.clear(); this.kinolyAwakened.clear(); this.kinolyObjectiveDone.clear();
    this.zazaTarget = this.mpamosavyTarget = this.seerTarget = this.kalanoroTarget = null;
    this.lastZazaTarget = this.lastMpamosavyTarget = this.lastKalanoroTarget = null;
    this.story = null;
    this.missions.clear();
    for (const p of this.players.values()) { p.alive = true; p.roleId = undefined; p.healUsed = false; p.exileUsed = false; }
    this.broadcastLobby();
  }

  // ── night machine ──
  private beginNight() {
    this.day += 1;
    this.nightVictim = null; this.nightHealed = false; this.nightExile = null; this.wolfVotes.clear();
    this.kinolyTargets.clear();
    this.zazaTarget = this.mpamosavyTarget = this.seerTarget = this.kalanoroTarget = null;
    this.usedHealThisNight = false; this.usedExileThisNight = false;
    this.steps = [];
    if (this.alivePlaying("zazavavindrano")) this.steps.push("zazavavindrano");
    if (this.alivePlaying("mpamosavy")) this.steps.push("mpamosavy");
    if (this.alivePlaying("mpisikidy")) this.steps.push("mpisikidy");
    if (this.alivePlaying("kalanoro")) this.steps.push("kalanoro");
    if (this.awakeKinolys().length > 0) this.steps.push("kinoly");
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
    else if (phase === "kalanoro") this.prompt("kalanoro", this.alivePlayers("kalanoro"), { targets: this.aliveExcept([this.firstAlive("kalanoro"), this.lastKalanoroTarget]) });
    else if (phase === "kinoly") this.prompt("kinoly", this.awakeKinolys(), { targets: this.aliveExcept(this.awakeKinolys().map((p) => p.id)) });
    else if (phase === "songomby") { this.sendWolves(); this.prompt("songomby", this.alivePack(), { targets: alive.filter((t) => !isPackKiller(this.players.get(t.id)?.roleId)) }); }
    else if (phase === "ombiasy") {
      const witch = this.alivePlayers("ombiasy")[0];
      if (witch) safeSend(witch.ws, { k: "wolves", wolfIds: [], victimId: this.nightVictim });
      this.prompt("ombiasy", this.alivePlayers("ombiasy"), { targets: alive, options: ["heal", "exile", "skip"] });
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

    const zazaP = this.firstAlivePlayer("zazavavindrano");
    const mpamP = this.firstAlivePlayer("mpamosavy");
    const seerP = this.firstAlivePlayer("mpisikidy");
    const kalP = this.firstAlivePlayer("kalanoro");
    const kinolyPs = this.awakeKinolys();
    const ombP = this.firstAlivePlayer("ombiasy");

    const preliminaryBlocked = new Set<string>();
    if (this.mpamosavyTarget) preliminaryBlocked.add(this.mpamosavyTarget);
    const waterOfferingCancel = this.findWaterOfferingCancel(zazaP, mpamP, kinolyPs, ombP, preliminaryBlocked);

    const blocked = new Set<string>();
    if (this.mpamosavyTarget && waterOfferingCancel?.kind !== "mpamosavy") blocked.add(this.mpamosavyTarget);

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
    for (const kinolyP of kinolyPs) {
      const targetId = this.kinolyTargets.get(kinolyP.id) ?? null;
      if (targetId && !blocked.has(kinolyP.id)) {
        visit(kinolyP.id, targetId, true);
        if (!(waterOfferingCancel?.kind === "kinoly" && waterOfferingCancel.actorId === kinolyP.id)) {
          this.markKinolyHaunt(kinolyP.id, targetId);
        }
      }
    }
    if (this.nightVictim) for (const w of this.alivePack()) visit(w.id, this.nightVictim, true); // pack kill is unblockable
    if (ombP && !ombBlocked) {
      if (this.nightHealed) visit(ombP.id, this.nightVictim, false);
      if (this.nightExile) visit(ombP.id, this.nightExile, true);
    }

    // a roleblocked witch loses her potion's effect — and gets the charge back
    if (ombBlocked && ombP) {
      if (this.usedHealThisNight) ombP.healUsed = false;
      if (this.usedExileThisNight) ombP.exileUsed = false;
      this.nightHealed = false; this.nightExile = null;
    }

    const effectiveNightVictim = waterOfferingCancel?.kind === "songomby" ? null : this.nightVictim;
    const effectiveNightExile = waterOfferingCancel?.kind === "ombiasy" ? null : this.nightExile;

    if (ombP && effectiveNightVictim === ombP.id && !this.nightHealed && this.consumeUnlockedReward(ombP.id, "ombiasy_self_protect")) {
      this.nightHealed = true;
      this.pushLog(`Sampy protecteur consommé par ${ombP.name}.`);
      this.sendMission(ombP);
    }

    // deaths (saves already accounted for)
    const deaths = new Set<string>();
    const fananyNightDeath = [effectiveNightVictim && !this.nightHealed ? effectiveNightVictim : null, effectiveNightExile]
      .find((id) => !!id && this.players.get(id)?.roleId === "fanany") ?? null;
    const fananyReplacementDeath = fananyNightDeath ? this.applyFananyReturnFady(fananyNightDeath, [
      ...(effectiveNightVictim === fananyNightDeath && !this.nightHealed ? this.alivePack().map((w) => w.id) : []),
      ...(effectiveNightExile === fananyNightDeath && ombP && !ombBlocked ? [ombP.id] : []),
    ]) : null;
    const fananyProtected = !!fananyReplacementDeath;
    if (fananyReplacementDeath) deaths.add(fananyReplacementDeath);
    if (effectiveNightVictim && !this.nightHealed && !(fananyProtected && effectiveNightVictim === fananyNightDeath)) deaths.add(effectiveNightVictim);
    if (effectiveNightExile && !(fananyProtected && effectiveNightExile === fananyNightDeath)) deaths.add(effectiveNightExile);
    this.awakenKinolyDeaths(deaths);
    this.applySongombyLayMark(this.nightVictim, deaths);

    // private dawn results
    if (seerP && this.seerTarget && !seerBlocked) this.sendSeer(seerP, this.seerTarget);
    if (kalP && this.kalanoroTarget && !kalBlocked) {
      const tgt = this.kalanoroTarget;
      const targetVisit = visits.find((v) => v.actorId === tgt) ?? null;
      let visited = !!targetVisit;
      // Kinoly "Peau lisse" : an awakened Kinoly that moved can erase its own night trace.
      const erased = visited
        && this.players.get(tgt)?.roleId === "kinoly"
        && this.consumeUnlockedReward(tgt, "kinoly_erase_trace");
      if (erased) {
        visited = false;
        this.pushLog(`Peau lisse consommée par ${this.name(tgt)} : sa trace nocturne s'efface.`);
        this.sendMission(this.players.get(tgt)!);
      }
      const namedTrace = !erased && this.consumeUnlockedReward(kalP.id, "kalanoro_named_trace");
      const destinationId = namedTrace ? targetVisit?.targetId ?? null : undefined;
      safeSend(kalP.ws, { k: "trackResult", targetId: tgt, visited, ...(namedTrace ? { destinationId } : {}) });
      this.pushLog(`Kalanoro piste ${this.name(tgt)} → ${visited ? "a quitté sa place" : "immobile"}${destinationId ? ` vers ${this.name(destinationId)}` : ""}.`);
      if (namedTrace) {
        this.pushLog(`Trace nommée consommée par ${kalP.name}.`);
        this.sendMission(kalP);
      }
    }
    if (zazaP && this.zazaTarget && !zazaBlocked) {
      const troubled = visits.some((v) => v.targetId === this.zazaTarget && v.hostile);
      if (troubled) { safeSend(zazaP.ws, { k: "fadyTrace", targetId: this.zazaTarget }); this.pushLog(`Le Fady des eaux sur ${this.name(this.zazaTarget)} a été troublé.`); }
    }
    // roleblock notifications (only to actors who actually tried to act)
    let silentCurseUsed = false;
    const notifyBlocked = (actor: Player | undefined, tried: boolean) => {
      if (!actor || !tried) return;
      if (!silentCurseUsed && mpamP && actor.id === this.mpamosavyTarget && this.consumeUnlockedReward(mpamP.id, "mpamosavy_silent_curse")) {
        silentCurseUsed = true;
        this.pushLog(`Malédiction muette consommée par ${mpamP.name}.`);
        this.sendMission(mpamP);
        return;
      }
      safeSend(actor.ws, { k: "blocked" });
    };
    notifyBlocked(seerP, seerBlocked && !!this.seerTarget);
    notifyBlocked(kalP, kalBlocked && !!this.kalanoroTarget);
    notifyBlocked(zazaP, zazaBlocked && !!this.zazaTarget);
    for (const kinolyP of kinolyPs) {
      notifyBlocked(kinolyP, blocked.has(kinolyP.id) && this.kinolyTargets.has(kinolyP.id));
    }
    notifyBlocked(ombP, ombBlocked && (this.usedHealThisNight || this.usedExileThisNight));

    this.lastZazaTarget = this.zazaTarget;
    this.lastMpamosavyTarget = this.mpamosavyTarget;
    this.lastKalanoroTarget = this.kalanoroTarget;

    this.beginDeaths([...deaths], () => this.beginDay());
  }

  // ── death resolution ──
  private beginDeaths(ids: string[], after: () => void) {
    this.afterDeaths = after;
    this.deathReveals = [];
    this.deathQueue = [...ids];
    this.resolveDeaths();
  }
  private resolveDeaths() {
    while (this.deathQueue.length) {
      const id = this.deathQueue.shift()!;
      const p = this.players.get(id);
      if (!p || !p.alive) continue;
      p.alive = false;
      this.deathReveals.push({ id, name: p.name, roleId: p.roleId ?? "mponina", nameMg: roleName(p.roleId ?? "mponina") });
      this.pushLog(`${p.name} meurt (${roleName(p.roleId ?? "mponina")}).`);
      if (p.roleId === "fanany") this.triggerFananyMarkRevenge();
    }
    if (this.deathReveals.length) {
      const dtext = this.story ? storyDeathText(this.story.deaths, this.deathReveals) : deathsText(this.deathReveals);
      this.broadcast({
        k: "deaths",
        ids: this.deathReveals.map((r) => r.id),
        reveals: this.deathReveals.map((r) => ({ id: r.id, roleId: r.roleId, nameMg: r.nameMg })),
        text: dtext,
      });
    } else if (this.phase === "aube") {
      this.broadcast({ k: "deaths", ids: [], reveals: [], text: "Personne n'est mort cette nuit." });
    }
    this.sendNarrator();
    const after = this.afterDeaths; this.afterDeaths = null;
    if (this.checkWin()) return;
    if (after) this.arm(this.config.manualDeaths && this.narratorId ? 90_000 : AUBE_PAUSE_MS, after); // narrator-paced reveal, or a brief beat
  }

  // ── day ──
  private beginDay() {
    if (this.fananyMarkDay < this.day) {
      this.fananyMark = null;
      this.fananyMarkDay = 0;
    }
    this.setPhase("debat", `Jour ${this.day} — Débat`, "Discutez, accusez, défendez-vous.");
    this.prompt("fanany", this.alivePlayers("fanany"), { targets: this.aliveExcept([this.firstAlive("fanany")]) });
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
    for (const [voterId, targetId] of this.votes) {
      const weight = this.voteWeight(voterId, targetId);
      counts.set(targetId, (counts.get(targetId) ?? 0) + weight);
    }
    const layTarget = this.songombyLayTarget;
    this.songombyLayTarget = null;
    if (layTarget && this.players.get(layTarget)?.alive) {
      const votes = counts.get(layTarget) ?? 0;
      if (votes > 0) {
        counts.set(layTarget, votes + 1);
        this.pushLog(`Lay des naseaux : ${this.name(layTarget)} reçoit un vote fantôme.`);
      } else {
        this.pushLog(`Lay des naseaux sur ${this.name(layTarget)} se dissipe sans effet.`);
      }
    }
    let max = 0; for (const c of counts.values()) max = Math.max(max, c);
    const top = [...counts.entries()].filter(([, c]) => c === max).map(([id]) => id);
    const eliminated = max > 0 && top.length ? top[(Math.random() * top.length) | 0]! : null;
    this.broadcast({ k: "voteResult", eliminatedId: eliminated, ...(eliminated ? { roleId: this.players.get(eliminated)!.roleId, nameMg: roleName(this.players.get(eliminated)!.roleId ?? "mponina") } : {}) });
    if (eliminated) { this.completeKinolyObjective(eliminated); this.beginDeaths([eliminated], () => this.beginNight()); }
    else { this.pushLog("Personne n'est éliminé."); this.sendNarrator(); if (!this.checkWin()) this.beginNight(); }
  }

  // ── win check (V2: village vs songomby parity; neutral roles ignored for parity) ──
  private checkWin(): boolean {
    const alive = this.aliveSeatPlayers();
    const evil = alive.filter((p) => roleTeam(p.roleId ?? "") === "songomby");
    const village = alive.filter((p) => roleTeam(p.roleId ?? "") === "village");
    if (evil.length === 0) return this.finish("village");
    if (evil.length >= village.length) return this.finish("songomby");
    return false;
  }
  private finish(winner: Team): boolean {
    this.clearTimer();
    this.phase = "finished";
    const reveal = [...this.players.values()].filter((p) => p.id !== this.narratorId)
      .map((p) => ({ id: p.id, name: p.name, roleId: p.roleId ?? "mponina", nameMg: roleName(p.roleId ?? "mponina") }));
    const text = this.story
      ? (winner === "village" ? this.story.victoryVillage : this.story.victorySongomby)
      : (winner === "village" ? "Le village a chassé tous les monstres ! 🎉" : "Les Songomby ont fait taire le village… 🐺");
    this.broadcast({ k: "finish", winner, text, reveal, missions: this.narratorMissionSheets(), personalWinners: this.personalWinners() });
    this.sendNarrator();
    return true;
  }

  // ── role powers (resolved at dawn) ──
  private awakenKinolyDeaths(deaths: Set<string>) {
    for (const id of [...deaths]) {
      const kinoly = this.players.get(id);
      if (!kinoly?.alive || kinoly.roleId !== "kinoly" || this.kinolyAwakened.has(id)) continue;
      deaths.delete(id);
      this.kinolyAwakened.add(id);
      this.pushLog(`${kinoly.name} devait mourir dans la nuit, mais le Kinoly s'éveille et reste parmi les vivants.`);
      this.sendMission(kinoly);
      this.sendNarrator();
    }
  }
  private applySongombyLayMark(targetId: string | null, deaths: Set<string>) {
    if (!targetId || deaths.has(targetId)) return;
    const target = this.players.get(targetId);
    if (!target?.alive) return;
    const songomby = this.consumeFirstUnlockedReward(this.alivePack(), "songomby_lay_mark");
    if (!songomby) return;
    this.songombyLayTarget = targetId;
    this.pushLog(`Lay des naseaux consommé par ${songomby.name} : ${target.name} est marqué jusqu'au prochain vote.`);
    this.sendMission(songomby);
  }
  private findWaterOfferingCancel(
    zaza: Player | undefined,
    mpamosavy: Player | undefined,
    kinolys: Player[],
    ombiasy: Player | undefined,
    preliminaryBlocked: Set<string>,
  ): WaterOfferingCancel | null {
    const targetId = this.zazaTarget;
    if (!zaza || !targetId || preliminaryBlocked.has(zaza.id)) return null;

    let candidate: WaterOfferingCancel | null = null;
    if (mpamosavy && this.mpamosavyTarget === targetId) {
      candidate = { kind: "mpamosavy", actorId: mpamosavy.id, targetId };
    } else {
      const kinoly = kinolys.find((p) => this.kinolyTargets.get(p.id) === targetId && !preliminaryBlocked.has(p.id));
      if (kinoly) candidate = { kind: "kinoly", actorId: kinoly.id, targetId };
      else if (this.nightVictim === targetId) candidate = { kind: "songomby", targetId };
      else if (ombiasy && this.nightExile === targetId && !preliminaryBlocked.has(ombiasy.id)) candidate = { kind: "ombiasy", actorId: ombiasy.id, targetId };
    }
    if (!candidate) return null;
    if (!this.consumeUnlockedReward(zaza.id, "zazavavindrano_water_offering")) return null;

    this.pushLog(`Offrande aux eaux consommée par ${zaza.name} : l'action hostile (${waterOfferingLabel(candidate.kind)}) contre ${this.name(targetId)} est annulée.`);
    this.sendMission(zaza);
    return candidate;
  }
  private triggerFananyMarkRevenge() {
    const targetId = this.fananyMark;
    this.fananyMark = null;
    this.fananyMarkDay = 0;
    if (!targetId || this.deathQueue.includes(targetId)) return;
    const target = this.players.get(targetId);
    if (!target?.alive) return;
    this.deathQueue.push(targetId);
    this.pushLog(`Vengeance des Razana : ${target.name} est emporté par la Marque funeste.`);
  }
  private applyFananyReturnFady(fananyId: string, murdererIds: string[]): string | null {
    const fanany = this.players.get(fananyId);
    if (!fanany?.alive || fanany.roleId !== "fanany") return null;
    const murderers = [...new Set(murdererIds)]
      .map((id) => this.players.get(id))
      .filter((p): p is Player => !!p && p.alive && p.id !== fanany.id);
    const murderer = murderers[(Math.random() * murderers.length) | 0];
    if (!murderer) return null;
    if (!this.consumeUnlockedReward(fanany.id, "fanany_return_fady")) return null;
    this.pushLog(`Fady de retour consommé par ${fanany.name} : ${murderer.name} meurt à sa place.`);
    this.sendMission(fanany);
    return murderer.id;
  }
  private sendSeer(seer: Player, targetId: string) {
    const t = this.players.get(targetId);
    if (!t) return;
    const deepScan = this.consumeUnlockedReward(seer.id, "mpisikidy_true_alignment_scan");
    const real = t.roleId ?? "mponina";
    const shown = deepScan ? real : t.roleId === "kinoly" ? "mponina" : real; // Kinoly disguise unless deep scan is active
    safeSend(seer.ws, { k: "seerResult", targetId, roleId: shown, nameMg: roleName(shown), ...(deepScan ? { team: roleTeam(shown) } : {}) });
    this.pushLog(`Le Mpisikidy lit ${t.name} → ${roleName(shown)}${deepScan ? ` (${roleTeam(shown)})` : ""}.`);
    if (deepScan) {
      this.pushLog(`Sikidy profond consommé par ${seer.name}.`);
      this.sendMission(seer);
    }
  }
  private markKinolyHaunt(kinolyId: string, targetId: string) {
    let targets = this.kinolyHaunts.get(kinolyId);
    if (!targets) { targets = new Set(); this.kinolyHaunts.set(kinolyId, targets); }
    targets.add(targetId);
    this.pushLog(`${this.name(kinolyId)} hante ${this.name(targetId)}.`);
  }
  private completeKinolyObjective(votedOutId: string) {
    for (const [kinolyId, targets] of this.kinolyHaunts) {
      const kinoly = this.players.get(kinolyId);
      if (!kinoly?.alive || !targets.has(votedOutId) || this.kinolyObjectiveDone.has(kinolyId)) continue;
      this.kinolyObjectiveDone.add(kinolyId);
      this.pushLog(`Objectif du Kinoly accompli : ${this.name(votedOutId)} tombe au vote après la hantise.`);
    }
  }
  private personalWinners(): PersonalWinner[] {
    return [...this.kinolyObjectiveDone]
      .map((id) => this.players.get(id))
      .filter((p): p is Player => !!p && p.alive && p.roleId === "kinoly")
      .map((p) => ({
        id: p.id,
        name: p.name,
        roleId: "kinoly",
        nameMg: roleName("kinoly"),
        reason: "A survécu après avoir mené une cible hantée au vote.",
      }));
  }
  private voteWeight(voterId: string, targetId: string): number {
    const voter = this.players.get(voterId);
    if (!voter?.alive || voter.roleId !== "mponina") return 1;
    if (!this.consumeUnlockedReward(voterId, "mponina_double_vote")) return 1;
    this.pushLog(`Voix du Fokonolona consommée par ${voter.name} : son vote compte double contre ${this.name(targetId)}.`);
    this.sendMission(voter);
    return 2;
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
  private awakeKinolys(): Player[] { return this.alivePlayers("kinoly").filter((p) => this.kinolyAwakened.has(p.id)); }
  private firstAlivePlayer(roleId: string): Player | undefined { return this.alivePlayers(roleId)[0]; }
  private alivePlaying(roleId: string): boolean { return this.alivePlayers(roleId).length > 0; }
  private firstAlive(roleId: string): string | undefined { return this.alivePlayers(roleId)[0]?.id; }
  private name(id: string): string { return this.players.get(id)?.name ?? "?"; }
  private pace() { return PACE_MS[this.config.pace ?? "normal"] ?? PACE_MS.normal; }
  private nightText(phase: Phase): string {
    return phase === "zazavavindrano" ? "Zazavavindrano lie une âme au Fady des eaux."
      : phase === "mpamosavy" ? "Le Mpamosavy souffle une malédiction."
      : phase === "mpisikidy" ? "Le Mpisikidy sonde un joueur."
      : phase === "kalanoro" ? "Le Kalanoro suit les pas inversés dans la nuit."
      : phase === "kinoly" ? "Le Kinoly cherche une porte où laisser sa trace."
      : phase === "songomby" ? "Les Songomby choisissent leur victime."
      : phase === "ombiasy" ? "L'Ombiasy choisit entre remède, ody et rituel d'exil." : "La nuit tombe…";
  }

  private setPhase(phase: Phase, title: string, text: string) {
    this.phase = phase;
    const a = PHASE_ASSET[phase];
    const dur = phase === "debat" ? this.pace().debate : phase === "vote" ? this.pace().vote : this.pace().night;
    const body = this.storyText(phase, text);
    this.lastPhase = { k: "phase", phase, day: this.day, audioKey: a.audio, imageKey: a.image, durationMs: dur, title, text: body };
    this.broadcast(this.lastPhase);
    this.broadcast({ k: "state", phase, day: this.day, players: [...this.players.values()].map(pub) });
    this.sendNarrator();
  }
  private storyText(phase: Phase, fallback: string): string {
    const s = this.story;
    if (!s) return fallback;
    if (isNightStoryPhase(phase)) return s.nightSteps[phase] || storyLine(s.dayProgression.night, this.day) || s.ambiance.night || fallback;
    if (phase === "aube") return storyLine(s.dayProgression.dawn, this.day) || s.ambiance.dawn || fallback;
    if (phase === "debat") return storyLine(s.dayProgression.debate, this.day) || s.ambiance.debate || fallback;
    if (phase === "vote") return storyLine(s.dayProgression.vote, this.day) || s.ambiance.vote || fallback;
    return fallback;
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
  private sendMission(p: Player) {
    if (p.roleId === "kinoly" && !this.kinolyAwakened.has(p.id)) return;
    const story = this.missions.get(p.id);
    if (story) safeSend(p.ws, { k: "playerStory", story });
  }
  private sendSelf(id: string) {
    const p = this.players.get(id); if (!p) return;
    safeSend(p.ws, { k: "lobby", code: this.code, hostId: this.hostId, narratorId: this.narratorId, selfId: id, config: this.config, players: [...this.players.values()].map(pub) });
    if (this.phase !== "lobby" && p.roleId) this.sendRole(p);
    if (this.phase !== "lobby") this.sendMission(p);
    if (this.phase !== "lobby" && this.story) safeSend(p.ws, this.storyMsg(this.story));
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
    safeSend(nar.ws, { k: "narrator", players, log: this.log.slice(-30), missionSheets: this.narratorMissionSheets() });
  }
  private narratorMissionSheets(): NarratorMissionSheet[] {
    return [...this.players.values()]
      .filter((p) => p.id !== this.narratorId)
      .filter((p) => p.roleId !== "kinoly" || this.kinolyAwakened.has(p.id))
      .map((p) => {
        const sheet = this.missions.get(p.id);
        if (!sheet) return null;
        const roleId = p.roleId ?? "mponina";
        return { ...sheet, playerName: p.name, roleId, nameMg: roleName(roleId), alive: p.alive };
      })
      .filter((sheet): sheet is NarratorMissionSheet => !!sheet);
  }
  private applyMissionStatus(sheet: PlayerMissionSheet, status: MissionStatus) {
    sheet.status = status;
    sheet.titlesEarned = status === "validated" ? 1 : 0;
    sheet.rewards = sheet.rewards.map((reward) => {
      if (reward.status === "used") return reward;
      return setRewardStatus(reward, sheet.titlesEarned >= reward.requiredTitles ? "unlocked" : "locked");
    });
  }
  private consumeUnlockedReward(playerId: string, rewardId: string): boolean {
    const sheet = this.missions.get(playerId);
    if (!sheet) return false;
    const result = useUnlockedReward(sheet.rewards, rewardId);
    if (!result.used) return false;
    sheet.rewards = result.rewards;
    this.sendNarrator();
    return true;
  }
  private consumeFirstUnlockedReward(players: Player[], rewardId: string): Player | null {
    for (const player of players) {
      if (this.consumeUnlockedReward(player.id, rewardId)) return player;
    }
    return null;
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
function storyLine(lines: string[], day: number): string {
  if (!lines.length) return "";
  return lines[Math.min(Math.max(0, day - 1), lines.length - 1)] ?? "";
}
function isNightStoryPhase(phase: Phase): phase is NightStoryPhase {
  return (NIGHT_STORY_PHASES as readonly string[]).includes(phase);
}
function storyDeathText(templates: string[], reveals: { name: string; nameMg: string }[]): string {
  const template = templates[(Math.random() * templates.length) | 0] ?? deathsText(reveals.map((r, i) => ({ id: String(i), nameMg: r.nameMg })));
  const names = reveals.map((r) => r.name).join(", ");
  const roles = [...new Set(reveals.map((r) => r.nameMg))].join(", ");
  return template
    .replaceAll("{victimName}", names)
    .replaceAll("{victim}", names)
    .replaceAll("{role}", roles)
    .replaceAll("{count}", String(reveals.length));
}
function pickMajority(votes: string[]): string | null {
  if (!votes.length) return null;
  const c = new Map<string, number>();
  for (const v of votes) c.set(v, (c.get(v) ?? 0) + 1);
  let max = 0; for (const n of c.values()) max = Math.max(max, n);
  const top = [...c.entries()].filter(([, n]) => n === max).map(([id]) => id);
  return top[(Math.random() * top.length) | 0]!;
}
function waterOfferingLabel(kind: WaterOfferingCancel["kind"]): string {
  return kind === "mpamosavy" ? "la malédiction"
    : kind === "kinoly" ? "la hantise"
    : kind === "songomby" ? "la chasse"
    : "le rituel d'exil";
}
function shuffle<T>(a: T[]): T[] { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j]!, a[i]!]; } return a; }
