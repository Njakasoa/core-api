import { validator as honoValidator } from "hono-openapi/zod";
import type { ZodSchema } from "zod";
import { errors } from "./errors.ts";

type Target = "json" | "query" | "param" | "header" | "cookie" | "form";

/**
 * Request validator that feeds OpenAPI *and* enforces our error envelope.
 * On failure it throws a 400 with the zod issues in `details`.
 */
export function validate<T extends ZodSchema>(target: Target, schema: T) {
  return honoValidator(target, schema, (result) => {
    if (!result.success) {
      throw errors.badRequest("Validation failed", result.error.issues);
    }
  });
}
