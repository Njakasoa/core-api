import { test, expect, mock } from "bun:test";

// Deterministic and offline: force the AI gateway to "no output" so generateStory
// falls back to a local preset (a local .env may set AI_API_TOKEN).
mock.module("../../lib/ai.ts", () => ({ aiGenerateJSON: async () => null }));

const { AnganoRoom } = await import("./room.ts");
import type { AnganoServerMsg } from "./protocol.ts";

type Captured = AnganoServerMsg[];
function sock() {
  const msgs: Captured = [];
  const ws = { send: (s: string) => { try { msgs.push(JSON.parse(s)); } catch { /* */ } } };
  return { ws, msgs };
}
const last = <K extends AnganoServerMsg["k"]>(msgs: Captured, k: K) =>
  [...msgs].reverse().find((m) => m.k === k) as Extract<AnganoServerMsg, { k: K }> | undefined;
const roleOf = (msgs: Captured) => last(msgs, "role")?.role.roleId;

const ALL_IDS = ["nar", "p1", "p2", "p3", "p4", "p5"];
async function makeRoom(config: Record<string, unknown> = {}) {
  const room = new AnganoRoom("ROOM", "nar");
  const nar = sock();
  room.join("nar", nar.ws as never, "Nar");
  const players = [1, 2, 3, 4, 5].map((i) => {
    const s = sock();
    room.join(`p${i}`, s.ws as never, `P${i}`);
    return { id: `p${i}`, ...s };
  });
  room.takeNarrator("nar", true);
  room.setConfig("nar", {
    songomby: 1,
    roles: ["mpisikidy", "ombiasy", "zazavavindrano", "kalanoro"],
    pace: "rapide",
    theme: false,
    ...config,
  } as never);
  await room.start("nar");
  return { room, nar, players };
}
const teardown = (room: InstanceType<typeof AnganoRoom>) => ALL_IDS.forEach((id) => room.disconnect(id));
const byRole = (players: { id: string; msgs: Captured }[], role: string) => players.find((p) => roleOf(p.msgs) === role);

test("same-room mode hands pacing to the narrator and flags it to clients", async () => {
  const { room, nar } = await makeRoom({ sameRoom: true });
  expect(last(nar.msgs, "phase")?.manualPacing).toBe(true);
  teardown(room);
});

test("remote mode keeps the timers and does not flag manual pacing", async () => {
  const { room, nar } = await makeRoom({ sameRoom: false });
  expect(last(nar.msgs, "phase")?.manualPacing).toBeUndefined();
  teardown(room);
});

test("an explicit autoAdvance overrides whatever the mode implies", async () => {
  const { room, nar } = await makeRoom({ sameRoom: true, autoAdvance: true });
  expect(last(nar.msgs, "phase")?.manualPacing).toBeUndefined();
  teardown(room);
});

test("the first night step cannot be rewound; a later one can", async () => {
  const { room, nar } = await makeRoom({ sameRoom: true });
  expect(last(nar.msgs, "narrator")?.canRewind).toBe(false); // nothing behind us yet

  room.nextPhase("nar");
  expect(last(nar.msgs, "narrator")?.canRewind).toBe(true);
  teardown(room);
});

test("stepping back re-enters the previous night phase", async () => {
  const { room, nar } = await makeRoom({ sameRoom: true });
  const first = last(nar.msgs, "phase")!.phase;

  room.nextPhase("nar");
  const second = last(nar.msgs, "phase")!.phase;
  expect(second).not.toBe(first);

  room.prevPhase("nar");
  expect(last(nar.msgs, "phase")?.phase).toBe(first);
  teardown(room);
});

test("a replayed step discards the choice that was already made", async () => {
  const { room, nar, players } = await makeRoom({ sameRoom: true });
  const seer = byRole(players, "mpisikidy");
  expect(seer).toBeDefined();

  // walk to the Mpisikidy step
  for (let i = 0; i < 6 && last(nar.msgs, "phase")?.phase !== "mpisikidy"; i++) room.nextPhase("nar");
  expect(last(nar.msgs, "phase")?.phase).toBe("mpisikidy");

  const target = players.find((p) => p.id !== seer!.id)!;
  room.action(seer!.id, target.id); // acting advances the step
  expect(last(nar.msgs, "phase")?.phase).not.toBe("mpisikidy");

  room.prevPhase("nar");
  expect(last(nar.msgs, "phase")?.phase).toBe("mpisikidy");
  // the seer is prompted again, so the earlier read is not locked in
  expect(last(seer!.msgs, "prompt")?.kind).toBe("mpisikidy");
  teardown(room);
});

test("the Ombiasy acting ends the night, so its remedy can no longer be taken back", async () => {
  const { room, nar, players } = await makeRoom({ sameRoom: true });
  const witch = byRole(players, "ombiasy");
  expect(witch).toBeDefined();

  for (let i = 0; i < 8 && last(nar.msgs, "phase")?.phase !== "ombiasy"; i++) room.nextPhase("nar");
  expect(last(nar.msgs, "phase")?.phase).toBe("ombiasy");

  // The Ombiasy is the last night step: acting resolves the night on the spot, and
  // the private reads go out with it. Rewinding is refused from here by design.
  room.action(witch!.id, null, "heal");
  expect(last(nar.msgs, "phase")?.phase).toBe("aube");
  room.prevPhase("nar");
  expect(last(nar.msgs, "phase")?.phase).toBe("aube");
  teardown(room);
});

test("leaving and re-entering the Ombiasy step leaves its remedy untouched", async () => {
  const { room, nar, players } = await makeRoom({ sameRoom: true });
  const witch = byRole(players, "ombiasy");
  expect(witch).toBeDefined();

  for (let i = 0; i < 8 && last(nar.msgs, "phase")?.phase !== "ombiasy"; i++) room.nextPhase("nar");
  expect(last(nar.msgs, "phase")?.phase).toBe("ombiasy");

  room.prevPhase("nar");                                   // mis-tap: back one step
  expect(last(nar.msgs, "phase")?.phase).not.toBe("ombiasy");
  room.nextPhase("nar");                                   // and forward again
  expect(last(nar.msgs, "phase")?.phase).toBe("ombiasy");

  room.action(witch!.id, null, "heal");                    // the remedy still works
  expect(last(nar.msgs, "narrator")?.log.some((l) => /soigne/i.test(l))).toBe(true);
  teardown(room);
});

test("rewind is refused once the night has resolved — the reads are already out", async () => {
  const { room, nar } = await makeRoom({ sameRoom: true });
  for (let i = 0; i < 12 && last(nar.msgs, "phase")?.phase !== "aube"; i++) room.nextPhase("nar");
  expect(last(nar.msgs, "phase")?.phase).toBe("aube");

  expect(last(nar.msgs, "narrator")?.canRewind).toBe(false);
  room.prevPhase("nar");
  expect(last(nar.msgs, "error")?.message).toMatch(/arrière/i);
  expect(last(nar.msgs, "phase")?.phase).toBe("aube"); // unmoved
  teardown(room);
});

test("only the narrator or host may steer the pacing", async () => {
  const { room, nar, players } = await makeRoom({ sameRoom: true });
  room.nextPhase("nar");
  const reached = last(nar.msgs, "phase")!.phase;

  room.prevPhase(players[0]!.id); // an ordinary player
  expect(last(nar.msgs, "phase")?.phase).toBe(reached);
  teardown(room);
});

test("a completed night step is announced, so the table can hear the turn close", async () => {
  const { room, nar, players } = await makeRoom({ sameRoom: true });
  const seer = byRole(players, "mpisikidy");
  expect(seer).toBeDefined();

  for (let i = 0; i < 6 && last(nar.msgs, "phase")?.phase !== "mpisikidy"; i++) room.nextPhase("nar");
  expect(last(nar.msgs, "phase")?.phase).toBe("mpisikidy");
  expect(last(nar.msgs, "acted")).toBeUndefined();   // nothing has been done yet

  const target = players.find((p) => p.id !== seer!.id)!;
  room.action(seer!.id, target.id);
  // it names the step that just closed, not the one opening — the sound belongs to
  // the deed, and the next phase message arrives in the same breath.
  expect(last(nar.msgs, "acted")?.phase).toBe("mpisikidy");
  // public: everyone hears it, which is the whole point around one table
  expect(last(target.msgs, "acted")?.phase).toBe("mpisikidy");
  teardown(room);
});

test("the Fanany's mark stays silent — it is taken in broad daylight", async () => {
  const { room, nar, players } = await makeRoom({ roles: ["fanany", "mpisikidy"], pace: "rapide" });
  const fanany = byRole(players, "fanany");
  expect(fanany).toBeDefined();

  // walk the night out to reach the debate
  for (let i = 0; i < 12 && last(nar.msgs, "phase")?.phase !== "debat"; i++) room.nextPhase("nar");
  expect(last(nar.msgs, "phase")?.phase).toBe("debat");

  const before = nar.msgs.filter((m) => m.k === "acted").length;
  const target = players.find((p) => p.id !== fanany!.id)!;
  room.action(fanany!.id, target.id);
  expect(last(nar.msgs, "narrator")?.log.some((l) => /Marque funeste/i.test(l))).toBe(true); // it landed
  expect(nar.msgs.filter((m) => m.k === "acted").length).toBe(before);                        // and said nothing
  teardown(room);
});
