import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { AppError } from "../lib/errors.ts";
import { isProd } from "../env.ts";

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
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
