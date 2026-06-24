import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import { verifyAccessToken } from "../lib/jwt.ts";

const { upgradeWebSocket, websocket } = createBunWebSocket();

/**
 * In-memory room registry — the foundation for the multiplayer game. One
 * process owns the sockets it holds; to scale across instances, fan messages
 * out through Redis pub/sub (or a Durable Object) keyed by room. The public
 * functions below stay the same.
 *
 * hono/bun may hand a fresh WSContext wrapper per event, so connections are
 * keyed by the stable underlying socket (`ws.raw`), and the WSContext captured
 * at open time is what we send through.
 */
type Socket = WSContext<unknown>;
interface Conn {
  ws: Socket;
  userId: string;
  rooms: Set<string>;
}

const conns = new Map<unknown, Conn>();
const rooms = new Map<string, Set<Conn>>();

const keyOf = (ws: Socket): unknown => ws.raw ?? ws;

function join(conn: Conn, room: string) {
  let set = rooms.get(room);
  if (!set) rooms.set(room, (set = new Set()));
  set.add(conn);
  conn.rooms.add(room);
}
function leave(conn: Conn, room: string) {
  const set = rooms.get(room);
  set?.delete(conn);
  if (set && set.size === 0) rooms.delete(room);
  conn.rooms.delete(room);
}

/** Broadcast a payload to every connection in a room (optionally excluding one). */
export function broadcast(room: string, payload: unknown, except?: Conn) {
  const set = rooms.get(room);
  if (!set) return;
  const msg = JSON.stringify(payload);
  for (const conn of set) if (conn !== except) conn.ws.send(msg);
}
export function roomSize(room: string): number {
  return rooms.get(room)?.size ?? 0;
}

function send(ws: Socket, payload: unknown) {
  ws.send(JSON.stringify(payload));
}

/**
 * GET /rt?token=<access JWT> — upgrade to a WebSocket.
 * Client → server messages: { type: "join"|"leave"|"broadcast", room, data? }
 */
export function realtimeRoute(): Hono {
  const app = new Hono();

  app.get(
    "/rt",
    upgradeWebSocket((c) => {
      const token = c.req.query("token") ?? "";
      return {
        async onOpen(_evt, ws) {
          const claims = await verifyAccessToken(token);
          if (!claims) {
            send(ws, { type: "error", message: "unauthorized" });
            ws.close(1008, "unauthorized");
            return;
          }
          conns.set(keyOf(ws), { ws, userId: claims.sub, rooms: new Set() });
          send(ws, { type: "ready", userId: claims.sub });
        },
        onMessage(evt, ws) {
          const conn = conns.get(keyOf(ws));
          if (!conn) return;
          let msg: { type?: string; room?: string; data?: unknown };
          try {
            msg = JSON.parse(String(evt.data));
          } catch {
            return send(ws, { type: "error", message: "invalid json" });
          }
          const room = msg.room;
          if (!room) return send(ws, { type: "error", message: "room required" });

          switch (msg.type) {
            case "join":
              join(conn, room);
              send(ws, { type: "joined", room, count: roomSize(room) });
              broadcast(room, { type: "presence", room, count: roomSize(room) }, conn);
              break;
            case "leave":
              leave(conn, room);
              send(ws, { type: "left", room });
              broadcast(room, { type: "presence", room, count: roomSize(room) });
              break;
            case "broadcast":
              if (!conn.rooms.has(room)) {
                return send(ws, { type: "error", message: "not in room" });
              }
              broadcast(
                room,
                { type: "message", room, from: conn.userId, data: msg.data },
                conn,
              );
              break;
            default:
              send(ws, { type: "error", message: "unknown type" });
          }
        },
        onClose(_evt, ws) {
          const conn = conns.get(keyOf(ws));
          if (conn) for (const room of conn.rooms) leave(conn, room);
          conns.delete(keyOf(ws));
        },
      };
    }),
  );

  return app;
}

export { websocket };
