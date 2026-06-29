import { test, expect, mock } from "bun:test";

// Keep the unit test deterministic and offline: force the AI gateway to "no output"
// so generateStory falls back to a local preset (a local .env may set AI_API_TOKEN).
mock.module("../../lib/ai.ts", () => ({ aiGenerateJSON: async () => null }));

const { AnganoRoom } = await import("./room.ts");
import type { AnganoServerMsg, PlayerMissionSheet } from "./protocol.ts";

type Captured = AnganoServerMsg[];
function sock() {
  const msgs: Captured = [];
  const ws = { send: (s: string) => { try { msgs.push(JSON.parse(s)); } catch { /* */ } } };
  return { ws, msgs };
}
const last = <K extends AnganoServerMsg["k"]>(msgs: Captured, k: K) =>
  [...msgs].reverse().find((m) => m.k === k) as Extract<AnganoServerMsg, { k: K }> | undefined;
const sheetOf = (msgs: Captured): PlayerMissionSheet | undefined => last(msgs, "playerStory")?.story;
const roleOf = (msgs: Captured): string | undefined => last(msgs, "role")?.role.roleId;
const narSheet = (msgs: Captured, id: string) => last(msgs, "narrator")?.missionSheets?.find((s) => s.playerId === id);

const ALL_IDS = ["nar", "p1", "p2", "p3", "p4", "p5"];
async function makeRoom() {
  const room = new AnganoRoom("ROOM", "nar");
  const nar = sock();
  room.join("nar", nar.ws as never, "Nar");
  const players = [1, 2, 3, 4, 5].map((i) => { const s = sock(); room.join(`p${i}`, s.ws as never, `P${i}`); return { id: `p${i}`, ...s }; });
  room.takeNarrator("nar", true);
  room.setConfig("nar", { songomby: 1, roles: ["mpisikidy", "ombiasy", "kinoly", "mpamosavy"], pace: "rapide", theme: true } as never);
  await room.start("nar");
  return { room, nar, players };
}
const teardown = (room: InstanceType<typeof AnganoRoom>) => ALL_IDS.forEach((id) => room.disconnect(id));
const byRole = (players: { id: string; msgs: Captured }[], role: string) => players.find((p) => roleOf(p.msgs) === role)!;

test("review request → narrator sees 'requested' → accept unlocks the reward", async () => {
  const { room, nar, players } = await makeRoom();
  const seer = byRole(players, "mpisikidy");

  room.requestMissionReview(seer.id);
  expect(sheetOf(seer.msgs)?.status).toBe("requested");
  expect(narSheet(nar.msgs, seer.id)?.status).toBe("requested");

  room.missionStatus("nar", seer.id, "validated");
  const after = sheetOf(seer.msgs);
  expect(after?.status).toBe("validated");
  expect(after?.rewards.some((r) => r.status === "unlocked")).toBe(true);
  teardown(room);
});

test("refusal returns to pending with a 'rejected' trace, then the player can re-request", async () => {
  const { room, players } = await makeRoom();
  const ombi = byRole(players, "ombiasy");

  room.requestMissionReview(ombi.id);
  expect(sheetOf(ombi.msgs)?.status).toBe("requested");

  room.missionStatus("nar", ombi.id, "pending"); // narrator refuses
  let s = sheetOf(ombi.msgs);
  expect(s?.status).toBe("pending");
  expect(s?.reviewRejected).toBe(true);
  expect(s?.rewards.every((r) => r.status === "locked")).toBe(true); // no premature unlock

  room.requestMissionReview(ombi.id); // re-request
  s = sheetOf(ombi.msgs);
  expect(s?.status).toBe("requested");
  expect(s?.reviewRejected).toBe(false);
  teardown(room);
});

test("a player's request only touches their own sheet (self-only)", async () => {
  const { room, nar, players } = await makeRoom();
  const a = byRole(players, "mpisikidy");
  const b = byRole(players, "ombiasy");

  room.requestMissionReview(a.id);
  expect(narSheet(nar.msgs, a.id)?.status).toBe("requested");
  expect(narSheet(nar.msgs, b.id)?.status).toBe("pending");
  expect(sheetOf(b.msgs)?.status).toBe("pending");
  teardown(room);
});

test("a dormant Kinoly cannot request a review before it awakens", async () => {
  const { room, players } = await makeRoom();
  const kinoly = byRole(players, "kinoly");
  const before = kinoly.msgs.length;

  room.requestMissionReview(kinoly.id);
  expect(sheetOf(kinoly.msgs)).toBeUndefined();   // dormant Kinoly never received a mission sheet
  expect(kinoly.msgs.length).toBe(before);        // request emitted nothing
  teardown(room);
});
