import { describe, expect, test } from "bun:test";
import { app } from "../src/app.ts";

const json = (res: Response) => res.json() as Promise<any>;
let n = 0;
const uniqueEmail = () => `t${Date.now()}_${n++}@core.test`;

async function register() {
  const email = uniqueEmail();
  const res = await app.request("/v1/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123", name: "T" }),
  });
  expect(res.status).toBe(201);
  const body = await json(res);
  return { email, ...body } as {
    email: string;
    accessToken: string;
    refreshToken: string;
    org: { id: string };
    user: { id: string };
  };
}

const authH = (token: string, orgId?: string) => ({
  Authorization: `Bearer ${token}`,
  ...(orgId ? { "X-Org-Id": orgId } : {}),
  "content-type": "application/json",
});

describe("health", () => {
  test("liveness + readiness", async () => {
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/readyz")).status).toBe(200);
  });
});

describe("auth", () => {
  test("register issues a session and rejects duplicates", async () => {
    const a = await register();
    expect(a.accessToken).toBeString();
    const dup = await app.request("/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: a.email, password: "password123" }),
    });
    expect(dup.status).toBe(409);
  });

  test("login + refresh rotation + logout", async () => {
    const a = await register();
    const login = await app.request("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: a.email, password: "password123" }),
    });
    expect(login.status).toBe(200);

    const r1 = await app.request("/v1/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: a.refreshToken }),
    });
    expect(r1.status).toBe(200);
    const refreshed = await json(r1);

    // Old refresh token is now revoked (rotation).
    const reuse = await app.request("/v1/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: a.refreshToken }),
    });
    expect(reuse.status).toBe(401);

    const logout = await app.request("/v1/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: refreshed.refreshToken }),
    });
    expect(logout.status).toBe(204);
  });

  test("rejects bad credentials and missing token", async () => {
    const a = await register();
    const bad = await app.request("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: a.email, password: "wrongpass1" }),
    });
    expect(bad.status).toBe(401);
    expect((await app.request("/v1/auth/me")).status).toBe(401);
  });
});

describe("items (org-scoped, paginated)", () => {
  test("CRUD + tenant isolation", async () => {
    const a = await register();
    const b = await register();

    const create = await app.request("/v1/items", {
      method: "POST",
      headers: authH(a.accessToken, a.org.id),
      body: JSON.stringify({ name: "alpha" }),
    });
    expect(create.status).toBe(201);
    const item = await json(create);

    // b cannot read a's item.
    const cross = await app.request(`/v1/items/${item.id}`, {
      headers: authH(b.accessToken, b.org.id),
    });
    expect(cross.status).toBe(404);

    // a can.
    const read = await app.request(`/v1/items/${item.id}`, {
      headers: authH(a.accessToken, a.org.id),
    });
    expect(read.status).toBe(200);

    const list = await app.request("/v1/items?limit=10", {
      headers: authH(a.accessToken, a.org.id),
    });
    expect((await json(list)).data.length).toBe(1);

    const del = await app.request(`/v1/items/${item.id}`, {
      method: "DELETE",
      headers: authH(a.accessToken, a.org.id),
    });
    expect(del.status).toBe(204);
  });

  test("idempotency replays the first response", async () => {
    const a = await register();
    const headers = { ...authH(a.accessToken, a.org.id), "Idempotency-Key": "x1" };
    const r1 = await app.request("/v1/items", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "idem" }),
    });
    const r2 = await app.request("/v1/items", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "idem" }),
    });
    expect(r2.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await json(r1)).id).toBe((await json(r2)).id);
  });
});

describe("api keys", () => {
  test("create, authenticate, scope enforcement, revoke", async () => {
    const a = await register();
    const created = await app.request("/v1/keys", {
      method: "POST",
      headers: authH(a.accessToken, a.org.id),
      body: JSON.stringify({ name: "ci", scopes: ["items:read", "items:write"] }),
    });
    expect(created.status).toBe(201);
    const { key, id } = await json(created);

    // Key is bound to the org — no X-Org-Id needed.
    const created2 = await app.request("/v1/items", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "by-key" }),
    });
    expect(created2.status).toBe(201);

    // Key without scope is forbidden.
    const noScope = await app.request("/v1/keys", {
      method: "POST",
      headers: authH(a.accessToken, a.org.id),
      body: JSON.stringify({ name: "x", scopes: [] }),
    });
    const { key: key2 } = await json(noScope);
    const denied = await app.request("/v1/items", {
      headers: { Authorization: `Bearer ${key2}` },
    });
    expect(denied.status).toBe(403);

    const revoke = await app.request(`/v1/keys/${id}`, {
      method: "DELETE",
      headers: authH(a.accessToken, a.org.id),
    });
    expect(revoke.status).toBe(204);

    const afterRevoke = await app.request("/v1/items", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(afterRevoke.status).toBe(401);
  });
});

describe("orgs", () => {
  test("non-member is forbidden, owner can add member", async () => {
    const a = await register();
    const b = await register();

    const forbidden = await app.request("/v1/orgs/current", {
      headers: authH(b.accessToken, a.org.id),
    });
    expect(forbidden.status).toBe(403);

    const add = await app.request("/v1/orgs/current/members", {
      method: "POST",
      headers: authH(a.accessToken, a.org.id),
      body: JSON.stringify({ email: b.email, role: "member" }),
    });
    expect(add.status).toBe(201);

    const nowMember = await app.request("/v1/orgs/current", {
      headers: authH(b.accessToken, a.org.id),
    });
    expect(nowMember.status).toBe(200);
  });
});

describe("webhooks", () => {
  test("register endpoint and enqueue a delivery on item.created", async () => {
    const a = await register();
    const ep = await app.request("/v1/webhooks", {
      method: "POST",
      headers: authH(a.accessToken, a.org.id),
      body: JSON.stringify({ url: "https://example.com/hook", events: ["item.created"] }),
    });
    expect(ep.status).toBe(201);
    const { id, secret } = await json(ep);
    expect(secret).toStartWith("whsec_");

    await app.request("/v1/items", {
      method: "POST",
      headers: authH(a.accessToken, a.org.id),
      body: JSON.stringify({ name: "trigger" }),
    });

    const deliveries = await app.request(`/v1/webhooks/${id}/deliveries`, {
      headers: authH(a.accessToken, a.org.id),
    });
    expect((await json(deliveries)).data.length).toBeGreaterThan(0);
  });
});

describe("openapi", () => {
  test("serves a 3.1 spec with documented paths", async () => {
    const spec = await json(await app.request("/openapi.json"));
    expect(spec.openapi).toStartWith("3.");
    expect(Object.keys(spec.paths).length).toBeGreaterThan(15);
  });
});
