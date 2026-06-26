import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import { verifyAccessToken } from "../../lib/jwt.ts";
import { upgradeWebSocket } from "../../realtime/bun-ws.ts";
import { QuizRoom } from "./room.ts";
import type { QuizClientMsg } from "./protocol.ts";

type Socket = WSContext<unknown>;

const rooms = new Map<string, QuizRoom>();
interface Conn { room: QuizRoom; userId: string; }
const conns = new Map<unknown, Conn>();
const keyOf = (ws: Socket): unknown => ws.raw ?? ws;

function getOrCreateRoom(code: string, hostId: string): QuizRoom {
  let room = rooms.get(code);
  if (!room) {
    room = new QuizRoom(code, hostId);
    room.onEmpty = () => rooms.delete(code);
    rooms.set(code, room);
  }
  return room;
}

/**
 * GET /quiz/rt?token=<access JWT>&room=<CODE> — server-authoritative quiz match.
 * The first player in a room is the host. See protocol.ts for the message shapes.
 */
export function quizRoute(): Hono {
  const app = new Hono();

  app.get(
    "/quiz/rt",
    upgradeWebSocket((c) => {
      const token = c.req.query("token") ?? "";
      const code = (c.req.query("room") ?? "").toUpperCase().slice(0, 8);
      const name = c.req.query("name") ?? "Joueur";
      return {
        async onOpen(_evt, ws) {
          const claims = await verifyAccessToken(token);
          if (!claims) {
            ws.send(JSON.stringify({ k: "error", message: "unauthorized" }));
            ws.close(1008, "unauthorized");
            return;
          }
          if (!code) {
            ws.send(JSON.stringify({ k: "error", message: "room required" }));
            ws.close(1008, "room required");
            return;
          }
          const room = getOrCreateRoom(code, claims.sub);
          conns.set(keyOf(ws), { room, userId: claims.sub });
          room.join(claims.sub, ws, name); // name from URL → no race, broadcasts the roster
          room.sendSnapshot(claims.sub);   // ensure the joiner gets code + selfId (esp. mid-match)
        },
        onMessage(evt, ws) {
          const conn = conns.get(keyOf(ws));
          if (!conn) return;
          let msg: QuizClientMsg;
          try { msg = JSON.parse(String(evt.data)); } catch { return; }
          const { room, userId } = conn;
          switch (msg.k) {
            case "hello": room.setName(userId, String(msg.name ?? "")); break;
            case "start": room.start(userId, String(msg.themeId ?? "")); break;
            case "answer": room.answer(userId, String(msg.questionId ?? ""), Number(msg.choiceIndex)); break;
          }
        },
        onClose(_evt, ws) {
          const conn = conns.get(keyOf(ws));
          if (!conn) return;
          conns.delete(keyOf(ws));
          conn.room.leave(conn.userId);
        },
      };
    }),
  );

  return app;
}
