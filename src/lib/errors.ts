import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * Typed application error. Throw these anywhere; the global error handler
 * turns them into a consistent JSON envelope:
 *   { "error": { "code": string, "message": string, "details"?: unknown } }
 */
export class AppError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    status: ContentfulStatusCode,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const errors = {
  badRequest: (msg = "Bad request", details?: unknown) =>
    new AppError(400, "bad_request", msg, details),
  unauthorized: (msg = "Authentication required") =>
    new AppError(401, "unauthorized", msg),
  forbidden: (msg = "You don't have access to this resource") =>
    new AppError(403, "forbidden", msg),
  notFound: (msg = "Not found") => new AppError(404, "not_found", msg),
  conflict: (msg = "Conflict", details?: unknown) =>
    new AppError(409, "conflict", msg, details),
  unprocessable: (msg = "Unprocessable", details?: unknown) =>
    new AppError(422, "unprocessable_entity", msg, details),
  tooManyRequests: (msg = "Too many requests") =>
    new AppError(429, "too_many_requests", msg),
  internal: (msg = "Internal server error") =>
    new AppError(500, "internal_error", msg),
};
