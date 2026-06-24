import { z } from "zod";

/** Query schema for cursor pagination. */
export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export type PageQuery = z.infer<typeof pageQuery>;

/** Opaque cursor = base64url of the last seen id. */
export function encodeCursor(value: string): string {
  return Buffer.from(value).toString("base64url");
}
export function decodeCursor(cursor: string | undefined): string | null {
  if (!cursor) return null;
  try {
    return Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Given rows fetched with `limit + 1`, split into the page and the next
 * cursor. Assumes rows are ordered by the cursor column.
 */
export function paginate<T extends { id: string }>(
  rows: T[],
  limit: number,
): { data: T[]; nextCursor: string | null } {
  if (rows.length > limit) {
    const page = rows.slice(0, limit);
    const last = page[page.length - 1]!;
    return { data: page, nextCursor: encodeCursor(last.id) };
  }
  return { data: rows, nextCursor: null };
}
