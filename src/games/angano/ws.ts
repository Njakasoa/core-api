import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import { verifyAccessToken } from "../../lib/jwt.ts";
import { upgradeWebSocket } from "../../realtime/bun-ws.ts";
import { AnganoRoom } from "./room.ts";
import type { AnganoClientMsg } from "./protocol.ts";

type Socket = WSContext<unknown>;

const rooms = new Map<string, AnganoRoom>();
interface Conn { room: AnganoRoom; userId: string; }
const conns = new Map<unknown, Conn>();
const keyOf = (ws: Socket): unknown => ws.raw ?? ws;

function getOrCreateRoom(code: string, hostId: string): AnganoRoom {
  let room = rooms.get(code);
  if (!room) { room = new AnganoRoom(code, hostId); room.onEmpty = () => rooms.delete(code); rooms.set(code, room); }
  return room;
}

/**
 * GET /angano/rt?token=<JWT>&room=<CODE>&name=<name> — the Angano social-deduction
 * game gateway. First player is the host. See protocol.ts for the message shapes.
 */
export function anganoRoute(): Hono {
  const app = new Hono();

  app.get(
    "/angano/rt",
    upgradeWebSocket((c) => {
      const token = c.req.query("token") ?? "";
      const code = (c.req.query("room") ?? "").toUpperCase().slice(0, 8);
      const name = c.req.query("name") ?? "Joueur";
      return {
        async onOpen(_evt, ws) {
          const claims = await verifyAccessToken(token);
          if (!claims) { ws.send(JSON.stringify({ k: "error", message: "unauthorized" })); ws.close(1008, "unauthorized"); return; }
          if (!code) { ws.send(JSON.stringify({ k: "error", message: "room required" })); ws.close(1008, "room required"); return; }
          const room = getOrCreateRoom(code, claims.sub);
          conns.set(keyOf(ws), { room, userId: claims.sub });
          room.join(claims.sub, ws, name);
        },
        onMessage(evt, ws) {
          const conn = conns.get(keyOf(ws));
          if (!conn) return;
          let msg: AnganoClientMsg;
          try { msg = JSON.parse(String(evt.data)); } catch { return; }
          const { room, userId } = conn;
          switch (msg.k) {
            case "hello": room.setName(userId, String(msg.name ?? "")); break;
            case "takeNarrator": room.takeNarrator(userId, !!msg.on); break;
            case "setConfig": room.setConfig(userId, msg.config); break;
            case "start": void room.start(userId); break;
            case "action": room.action(userId, msg.targetId, msg.extra); break;
            case "vote": room.vote(userId, msg.targetId); break;
            case "nextPhase": room.nextPhase(userId); break;
            case "rematch": room.rematch(userId); break;
          }
        },
        onClose(_evt, ws) {
          const conn = conns.get(keyOf(ws));
          if (!conn) return;
          conns.delete(keyOf(ws));
          conn.room.disconnect(conn.userId);
        },
      };
    }),
  );

  return app;
}
