import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Knex } from 'knex';

/**
 * Account admin keys for the M19 admin HTTP API. Account-scoped only —
 * provisioning keys are deliberately *not* in this table; they live in
 * `.env` as `SW_PROVISIONING_KEY` (see `src/config/secrets.ts` and the
 * air-gap rationale in dev-notes/10-saas-shape.md).
 *
 * Token shape: `sw_<base64url-32>` (46 chars total). Stored as the sha-256
 * hex of the entire string (prefix included), 64 chars. Raw key is shown
 * once at mint time and never persisted — GitHub-PAT style.
 */

export interface AdminKey {
  id: string;
  account_id: string;
  description: string | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

/**
 * Subset returned to `getAdminKeyByHash` callers. Same shape as `AdminKey`
 * with the typed assurance that the row is currently valid (not revoked).
 * The auth middleware uses this to decide whether to proceed.
 */
export interface ValidAdminKey extends AdminKey {
  revoked_at: null;
}

/**
 * Result of minting a new admin key. The `rawKey` field is the only place
 * the plaintext value ever exists in our process memory; the CLI prints it
 * to the operator immediately and the value is then discarded.
 */
export interface MintedAdminKey {
  id: string;
  account_id: string;
  description: string | null;
  created_at: Date;
  /** Raw bearer the operator pastes into their HTTP client. Shown ONCE. */
  rawKey: string;
}

/** sha-256 hex of the input. Used to derive the hash stored in token_hash. */
export function hashAdminKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

/**
 * Generate the raw bearer string the operator gets. Format matches the
 * provisioning-key shape for grep'ability: `sw_<base64url-32>`.
 */
function generateRawKey(): string {
  return `sw_${randomBytes(32).toString('base64url')}`;
}

/**
 * Mint a new admin key against an account. Returns the row metadata + the
 * raw bearer string exactly once; the row stores only the sha-256 hash.
 *
 * The collision check is belt-and-braces — 32 random bytes won't collide
 * in practice, but the UNIQUE constraint on `token_hash` would surface a
 * duplicate as a mysql2 error far from the call site. Catching it here
 * gives the caller a coherent retry signal.
 */
export async function createAdminKey(
  db: Knex,
  input: { accountId: string; description?: string | null },
): Promise<MintedAdminKey> {
  const id = randomUUID();
  const rawKey = generateRawKey();
  const tokenHash = hashAdminKey(rawKey);

  await db('admin_keys').insert({
    id,
    account_id: input.accountId,
    token_hash: tokenHash,
    description: input.description ?? null,
  });

  const row = await db<AdminKey>('admin_keys').where({ id }).first();
  if (!row) {
    throw new Error(`createAdminKey: insert succeeded but read-back failed for id=${id}`);
  }

  return {
    id: row.id,
    account_id: row.account_id,
    description: row.description,
    created_at: row.created_at,
    rawKey,
  };
}

/**
 * Look up an admin key by its bearer hash. Used by the (M19) bearer-auth
 * middleware on `/admin/chatbots/*`. Returns null if the bearer doesn't
 * match any row, or if the matching row has been revoked. Bumps
 * `last_used_at` on a successful lookup (operator load; not user load,
 * so the per-request UPDATE is fine for v1).
 */
export async function getAdminKeyByHash(
  db: Knex,
  tokenHash: string,
): Promise<ValidAdminKey | null> {
  const row = await db<AdminKey>('admin_keys').where({ token_hash: tokenHash }).first();
  if (!row) return null;
  if (row.revoked_at !== null) return null;
  // Bump last_used_at outside the read query so concurrent reads stay
  // consistent. Fire-and-forget would lose the signal on failure; await
  // is cheap.
  await db('admin_keys').where({ id: row.id }).update({ last_used_at: db.fn.now() });
  return { ...row, revoked_at: null };
}

/**
 * List admin keys for an account. Shows both active and revoked rows;
 * operators decide what to do with stale ones. Never includes `token_hash`
 * — that column is secret-equivalent at rest, and a CLI list view has no
 * legitimate need for it. Ordered: newest first.
 */
export async function listAdminKeys(db: Knex, accountId: string): Promise<AdminKey[]> {
  const rows = await db<AdminKey>('admin_keys')
    .where({ account_id: accountId })
    .orderBy('created_at', 'desc');
  return rows.map((r) => ({
    id: r.id,
    account_id: r.account_id,
    description: r.description,
    last_used_at: r.last_used_at,
    revoked_at: r.revoked_at,
    created_at: r.created_at,
  }));
}

/**
 * Revoke an admin key. Idempotent — calling revoke on an already-revoked
 * key is a no-op (returns the existing `revoked_at`). Throws when the key
 * isn't found *or* when it belongs to a different account: cross-account
 * revocation would be a privilege escalation surface.
 */
export async function revokeAdminKey(
  db: Knex,
  accountId: string,
  keyId: string,
): Promise<AdminKey> {
  const row = await db<AdminKey>('admin_keys').where({ id: keyId }).first();
  if (!row) {
    throw new Error(`Admin key not found: id="${keyId}"`);
  }
  if (row.account_id !== accountId) {
    throw new Error(
      `Admin key id="${keyId}" does not belong to account "${accountId}". Refusing to revoke.`,
    );
  }
  if (row.revoked_at === null) {
    await db('admin_keys').where({ id: keyId }).update({ revoked_at: db.fn.now() });
  }
  const updated = await db<AdminKey>('admin_keys').where({ id: keyId }).first();
  if (!updated) {
    throw new Error(`revokeAdminKey: read-back failed for id="${keyId}"`);
  }
  return updated;
}
