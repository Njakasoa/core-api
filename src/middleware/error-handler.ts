import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { AppError } from "../lib/errors.ts";
import { isProd } from "../env.ts";

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/**
 * Une règle écrite dans la base doit arriver au client comme une règle.
 *
 * Ce dépôt met ses invariants dans Postgres plutôt que dans l'application —
 * « un contrôle à un `db.update()` distrait de sa disparition ». Le prix, jusqu'à
 * présent invisible : une contrainte qui lève remontait ici comme une erreur
 * inconnue, donc en 500, et `isProd` en masquait le message. La base écrit
 * pourtant des phrases françaises destinées à être lues.
 *
 * C'était tolérable tant que seuls des curateurs franchissaient ces portes. Ça
 * ne l'est plus : n'importe qui connecté peut désormais proposer une correction,
 * et les déclencheurs qui la vérifient sont sur son chemin. Un contributeur qui
 * lit « Internal server error » là où la base a écrit « entre 12 et 22 la lecture
 * porte « hoatra », la proposition dit avoir lu « hontra » » n'a aucun moyen de
 * comprendre ce qu'on lui reproche.
 *
 * Les `RAISE EXCEPTION` de nos déclencheurs portent le code P0001 et un message
 * déjà rédigé pour l'utilisateur : il est transmis tel quel. Les violations de
 * contrainte, elles, ont un message Postgres illisible — on rend le NOM de la
 * contrainte, qui est la seule chose stable et diagnosticable, dans `details`.
 */
interface ErreurPg {
  code?: string;
  message?: string;
  constraint_name?: string;
  detail?: string;
}

function erreurPostgres(
  err: Error,
): { status: 409 | 422; corps: ErrorBody["error"] } | null {
  const e = err as unknown as ErreurPg;
  if (typeof e.code !== "string" || !/^[0-9A-Z]{5}$/.test(e.code)) return null;

  // P0001 : nos propres RAISE. Le message est écrit pour être lu.
  if (e.code === "P0001") {
    return {
      status: 422,
      corps: { code: "regle_du_corpus", message: e.message ?? "règle refusée" },
    };
  }
  // 23514 CHECK · 23P01 EXCLUDE · 23505 UNIQUE — un conflit avec l'existant.
  if (e.code === "23514" || e.code === "23P01" || e.code === "23505") {
    return {
      status: 409,
      corps: {
        code: "conflit_de_donnees",
        message: "cette écriture entre en conflit avec une règle de la base",
        details: { contrainte: e.constraint_name },
      },
    };
  }
  // 23503 : une clé étrangère absente — la requête désigne quelque chose qui
  // n'existe pas, ce qui est une demande mal formée, pas un conflit.
  if (e.code === "23503") {
    return {
      status: 422,
      corps: {
        code: "reference_inconnue",
        message: "cette écriture désigne une ligne qui n'existe pas",
        details: { contrainte: e.constraint_name },
      },
    };
  }
  return null;
}

/** Global error handler — maps everything to a consistent JSON envelope. */
export function onError(err: Error, c: Context) {
  if (err instanceof AppError) {
    return c.json<ErrorBody>(
      { error: { code: err.code, message: err.message, details: err.details } },
      err.status,
    );
  }

  if (err instanceof ZodError) {
    return c.json<ErrorBody>(
      {
        error: {
          code: "bad_request",
          message: "Validation failed",
          details: err.issues,
        },
      },
      400,
    );
  }

  if (err instanceof HTTPException) {
    return c.json<ErrorBody>(
      { error: { code: "http_error", message: err.message } },
      err.status,
    );
  }

  const pg = erreurPostgres(err);
  if (pg) return c.json<ErrorBody>({ error: pg.corps }, pg.status);

  // Unknown / unexpected → 500, hide internals in production.
  console.error("[unhandled]", err);
  return c.json<ErrorBody>(
    {
      error: {
        code: "internal_error",
        message: isProd ? "Internal server error" : err.message,
      },
    },
    500,
  );
}

export function notFound(c: Context) {
  return c.json<ErrorBody>(
    { error: { code: "not_found", message: "Route not found" } },
    404,
  );
}
