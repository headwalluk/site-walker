/**
 * Pull the bearer token out of an `Authorization: Bearer <…>` header.
 * Returns null when the header is absent or doesn't match the expected
 * shape — callers decide whether that's a 401 `bearer_required` or
 * `bearer_invalid` based on the surface they're guarding.
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = /^Bearer (.+)$/.exec(authHeader);
  return match ? match[1] : null;
}
