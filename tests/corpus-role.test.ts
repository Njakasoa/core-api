import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createApp } from "../src/app.ts";
import { db } from "../src/db/index.ts";
import { corpusRoles, orgMembers } from "../src/db/schema.ts";
import { eq } from "drizzle-orm";
import { id } from "../src/lib/ids.ts";
import { requireAuth } from "../src/middleware/auth.ts";
import { requireCorpusRole, requireRealUser } from "../src/middleware/corpus-role.ts";
import { onError } from "../src/middleware/error-handler.ts";
import type { Variables } from "../src/types.ts";

/**
 * `requireCorpusRole` is not mounted on any route yet — moderation and curation
 * are the next slice. That is exactly why it is tested now rather than later:
 * an authorisation middleware that ships untested is one whose first bug is
 * discovered by whoever it was supposed to stop.
 *
 * It is exercised through a throwaway app rather than a production route, so
 * these tests keep their meaning when the real endpoints arrive.
 */
const app = createApp();

let n = 0;
async function compte() {
  const email = `role${Date.now()}_${n++}@core.test`;
  const res = await app.request("/v1/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery" }),
  });
  const b = (await res.json()) as { accessToken: string; user: { id: string }; org: { id: string } };
  return { token: b.accessToken, userId: b.user.id, orgId: b.org.id };
}

/** A minimal app that does nothing but answer the authorisation question. */
function garde(mw: ReturnType<typeof requireCorpusRole>) {
  const a = new Hono<{ Variables: Variables }>();
  a.onError(onError);
  a.use("*", requireAuth, mw);
  a.get("/", (c) => c.text("ok"));
  return a;
}

async function frappe(a: Hono<{ Variables: Variables }>, token?: string) {
  return (await a.request("/", {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })).status;
}

describe("requireCorpusRole", () => {
  test("holding no role is not holding the role", async () => {
    const u = await compte();
    expect(await frappe(garde(requireCorpusRole("curateur")), u.token)).toBe(403);
  });

  test("no token at all is 401, not 403", async () => {
    // The distinction matters to a client: 401 means "identify yourself",
    // 403 means "you did, and it is not enough".
    expect(await frappe(garde(requireCorpusRole("curateur")))).toBe(401);
  });

  test("a granted role opens the door, and only that door", async () => {
    const u = await compte();
    await db.insert(corpusRoles).values({
      id: id("crole"), userId: u.userId, role: "moderateur", grantedByUserId: u.userId,
    });
    expect(await frappe(garde(requireCorpusRole("moderateur")), u.token)).toBe(200);
    // Being a moderator is not being a curator. The whole point of a closed set
    // of named roles is that they do not bleed into one another.
    expect(await frappe(garde(requireCorpusRole("curateur")), u.token)).toBe(403);
    // And a middleware that accepts several roles accepts this one among them.
    expect(await frappe(garde(requireCorpusRole("curateur", "moderateur")), u.token)).toBe(200);
  });

  test("a revoked role is no role", async () => {
    const u = await compte();
    const roleId = id("crole");
    await db.insert(corpusRoles).values({
      id: roleId, userId: u.userId, role: "relecteur", grantedByUserId: u.userId,
    });
    expect(await frappe(garde(requireCorpusRole("relecteur")), u.token)).toBe(200);
    await db.update(corpusRoles).set({ revokedAt: new Date() }).where(eq(corpusRoles.id, roleId));
    expect(await frappe(garde(requireCorpusRole("relecteur")), u.token)).toBe(403);
  });

  test("a role held by an organisation reaches its members", async () => {
    // A community authority is an institution, not a person, and its members
    // act for it. Without this, `communaute` could only ever be held by one
    // individual — which is precisely what a community authority is not.
    const patron = await compte();
    const membre = await compte();
    await db.insert(orgMembers).values({
      id: id("mem"), orgId: patron.orgId, userId: membre.userId, role: "member",
    });
    await db.insert(corpusRoles).values({
      id: id("crole"), orgId: patron.orgId, role: "communaute", grantedByUserId: patron.userId,
    });
    expect(await frappe(garde(requireCorpusRole("communaute")), membre.token)).toBe(200);

    // Someone outside the organisation gets nothing from it.
    const dehors = await compte();
    expect(await frappe(garde(requireCorpusRole("communaute")), dehors.token)).toBe(403);
  });

  test("X-Org-Id buys nothing", async () => {
    // `requireRole()` reads the org from a client-supplied header, and every
    // registrant is owner of the org created at signup — so an org role can
    // never mean "moderator of the platform". requireCorpusRole must ignore
    // the header entirely, or it inherits the same limitation.
    const u = await compte();
    const a = garde(requireCorpusRole("curateur"));
    const res = await a.request("/", {
      headers: { Authorization: `Bearer ${u.token}`, "X-Org-Id": u.orgId },
    });
    expect(res.status).toBe(403);
  });
});

describe("requireRealUser refuses a machine", () => {
  test("an API key cannot contribute a tale", async () => {
    // The other half of the write promise, and it had no test. A key carries
    // no consent, no attribution and no name — which is all a contribution is.
    const u = await compte();
    const cree = await app.request("/v1/keys", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${u.token}`,
        "X-Org-Id": u.orgId,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "sonde", scopes: ["items:read"] }),
    });
    expect(cree.status).toBe(201);
    const { key } = (await cree.json()) as { key: string };

    const res = await app.request("/v1/collecte/tales", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        titreSource: "Par une machine", nouveaute: "INEDIT_ORAL",
        dialecteSource: "merina", texte: "Nisy indray mandeha.",
      }),
    });
    expect(res.status).toBe(401);
  });

  test("the same key still works where a machine belongs", async () => {
    // The refusal must be about contribution, not about API keys being broken.
    const u = await compte();
    const cree = await app.request("/v1/keys", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${u.token}`, "X-Org-Id": u.orgId,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "sonde2", scopes: ["items:read"] }),
    });
    const { key } = (await cree.json()) as { key: string };
    const res = await app.request("/v1/items", {
      headers: { Authorization: `Bearer ${key}`, "X-Org-Id": u.orgId },
    });
    expect(res.status).toBe(200);
  });
});
