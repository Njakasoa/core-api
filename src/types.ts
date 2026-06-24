/** Authenticated principal — set by the auth middleware. */
export type Auth =
  | { kind: "user"; userId: string }
  | { kind: "apiKey"; apiKeyId: string; orgId: string; scopes: string[] };

/** Resolved active organization + the caller's role within it. */
export interface OrgContext {
  id: string;
  role: string;
}

/** Hono context variables available via c.get(...) / c.var. */
export type Variables = {
  requestId: string;
  auth: Auth;
  org: OrgContext;
};
