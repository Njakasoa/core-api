import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { db } from "../src/db/index.ts";
import { taleVersions } from "../src/db/schema.ts";
import { eq, sql } from "drizzle-orm";

/**
 * Integration tests for the collecte module. Needs a real Postgres — the two
 * properties that matter most (the raw text cannot be rewritten, and a tale
 * cannot be submitted without a named consenting teller) are enforced by the
 * database and by a transaction, so testing them against a mock would test the
 * mock.
 */
const app = createApp();

let n = 0;
async function compte() {
  const email = `collecte${Date.now()}_${n++}@core.test`;
  const res = await app.request("/v1/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery" }),
  });
  const body = (await res.json()) as { accessToken: string };
  return { headers: { Authorization: `Bearer ${body.accessToken}`, "content-type": "application/json" } };
}

const UN_CONTE = {
  titreSource: "Ikotofetsy sy Imahaka",
  nouveaute: "INEDIT_ORAL" as const,
  dialecteSource: "betsimisaraka",
  regionCollecte: "Toamasina",
  texte: "Nisy indray mandeha, hono, lehilahy roa nifaninana tamin'ny hafetsena.",
};

const UN_CONSENTEMENT = {
  grantorRole: "conteur" as const,
  grantorDisplay: "Ranaivo, mon grand-père",
  attribution: "nom_reel" as const,
  capturedVia: "oral_enregistre" as const,
  langueDuFormulaire: "plt_Latn" as const,
  finalites: ["archivage", "rag"],
  signedAt: new Date().toISOString(),
};

async function creerConte(h: Record<string, string>, corps = UN_CONTE) {
  const res = await app.request("/v1/collecte/tales", {
    method: "POST", headers: h, body: JSON.stringify(corps),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

describe("who may do what", () => {
  test("reading is anonymous, contributing is not", async () => {
    const anon = await app.request("/v1/collecte/tales");
    expect(anon.status).toBe(200);

    const sansJeton = await app.request("/v1/collecte/tales", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(UN_CONTE),
    });
    expect(sansJeton.status).toBe(401);
  });

  test("a guest session cannot contribute — 401, not a 500 from the database", async () => {
    // POST /v1/auth/guest mints a token whose subject has no row in `users`.
    // Without requireRealUser the insert would raise a foreign-key violation
    // and the API would answer 500 to what is plainly an authorisation problem.
    const g = await app.request("/v1/auth/guest", { method: "POST" });
    const { accessToken } = (await g.json()) as { accessToken: string };
    const res = await app.request("/v1/collecte/tales", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(UN_CONTE),
    });
    expect(res.status).toBe(401);
  });

  test("a submission belongs to its author and to nobody else", async () => {
    const moi = await compte();
    const autre = await compte();
    const { id } = await creerConte(moi.headers);
    const res = await app.request(`/v1/collecte/tales/${id}/consents`, {
      method: "POST", headers: autre.headers, body: JSON.stringify(UN_CONSENTEMENT),
    });
    expect(res.status).toBe(403);
  });

  test("a draft is not public", async () => {
    const moi = await compte();
    const { id } = await creerConte(moi.headers);
    const res = await app.request(`/v1/collecte/tales/${id}`);
    expect(res.status).toBe(404);
  });
});

describe("the intake gate", () => {
  test("no tale is submitted without a named consenting teller", async () => {
    const moi = await compte();
    const { id } = await creerConte(moi.headers);
    const res = await app.request(`/v1/collecte/tales/${id}/submit`, {
      method: "POST", headers: moi.headers,
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { details: { manquant: string[] } } };
    expect(body.error.details.manquant).toContain("consentement du conteur");
  });

  test("a transcriber's consent is not the teller's", async () => {
    // The failure mode this whole design exists to prevent: someone records
    // their grandmother, ticks a licence box, and the grandmother granted
    // nothing. The submitter licenses their transcription; the teller licenses
    // the telling. Two instruments, and only one of them is enough.
    const moi = await compte();
    const { id } = await creerConte(moi.headers);
    await app.request(`/v1/collecte/tales/${id}/consents`, {
      method: "POST",
      headers: moi.headers,
      body: JSON.stringify({ ...UN_CONSENTEMENT, grantorRole: "transcripteur" }),
    });
    const res = await app.request(`/v1/collecte/tales/${id}/submit`, {
      method: "POST", headers: moi.headers,
    });
    expect(res.status).toBe(422);
  });

  test("with the teller named, the submission goes through — once", async () => {
    const moi = await compte();
    const { id } = await creerConte(moi.headers);
    await app.request(`/v1/collecte/tales/${id}/consents`, {
      method: "POST", headers: moi.headers, body: JSON.stringify(UN_CONSENTEMENT),
    });
    const ok = await app.request(`/v1/collecte/tales/${id}/submit`, {
      method: "POST", headers: moi.headers,
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { status: string }).status).toBe("submitted");

    const encore = await app.request(`/v1/collecte/tales/${id}/submit`, {
      method: "POST", headers: moi.headers,
    });
    expect(encore.status).toBe(409);
  });

  test("a tale with no declared dialect is not ready", async () => {
    const moi = await compte();
    const { id } = await creerConte(moi.headers, { ...UN_CONTE, dialecteSource: undefined as never });
    await app.request(`/v1/collecte/tales/${id}/consents`, {
      method: "POST", headers: moi.headers, body: JSON.stringify(UN_CONSENTEMENT),
    });
    const res = await app.request(`/v1/collecte/tales/${id}/submit`, {
      method: "POST", headers: moi.headers,
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { details: { manquant: string[] } } };
    expect(body.error.details.manquant).toContain("dialecteSource");
  });
});

describe("the raw text is never rewritten", () => {
  test("a correction may repair layout, not rewrite the telling", async () => {
    const moi = await compte();
    const { id } = await creerConte(moi.headers);

    // Rejoining a hyphenated line break: layout only, well under 2 %.
    const propre = await app.request(`/v1/collecte/tales/${id}/corrections`, {
      method: "POST",
      headers: moi.headers,
      body: JSON.stringify({
        texte: "Nisy indray mandeha, hono, lehilahy roa nifaninana tamin'ny hafetsena!",
        origine: "césures recollées",
      }),
    });
    expect(propre.status).toBe(201);

    // A different telling of the same story. Fluent, plausible, and not what
    // the contributor submitted — which is exactly what must not pass.
    const reecrit = await app.request(`/v1/collecte/tales/${id}/corrections`, {
      method: "POST",
      headers: moi.headers,
      body: JSON.stringify({
        texte: "Taloha ela be, nisy mpangalatra roa tao an-tanàna izay nifanandrina isan'andro.",
        origine: "réécriture",
      }),
    });
    expect(reecrit.status).toBe(422);
  });

  test("the database itself refuses to alter the raw version", async () => {
    // Not an application check: an application check is one careless
    // db.update() away from gone, and nobody would ever know it happened.
    const moi = await compte();
    const { id } = await creerConte(moi.headers);
    const [brute] = await db
      .select().from(taleVersions)
      .where(eq(taleVersions.taleId, id)).limit(1);
    expect(brute?.kind).toBe("brute");

    let refus: unknown;
    try {
      await db.update(taleVersions)
        .set({ texte: "réécrit en douce" })
        .where(eq(taleVersions.id, brute!.id));
    } catch (e) {
      refus = e;
    }
    expect(refus).toBeDefined();
    expect(String(refus)).toContain("append-only");

    const [apres] = await db
      .select().from(taleVersions)
      .where(eq(taleVersions.id, brute!.id)).limit(1);
    expect(apres?.texte).toBe(UN_CONTE.texte);
  });

  test("a published tale shows its raw form beside the corrected one", async () => {
    // Publishing only the tidy version would make the 2 % rule unverifiable by
    // anyone outside this codebase.
    const moi = await compte();
    const { id } = await creerConte(moi.headers);
    // Curation is not built yet, so the acceptance is applied directly. When
    // POST /decisions lands this becomes a call and the test keeps its meaning.
    await db.execute(sql`update tales set status = 'accepted' where id = ${id}`);
    const res = await app.request(`/v1/collecte/tales/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { versions: { kind: string }[]; validationCommunautaire: null };
    expect(body.versions.some((v) => v.kind === "brute")).toBe(true);
    // Attested is not validated, and the field says so on every tale.
    expect(body.validationCommunautaire).toBeNull();
  });
});
