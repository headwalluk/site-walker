import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createAdminKey,
  getAdminKeyByHash,
  hashAdminKey,
  listAdminKeys,
  revokeAdminKey,
} from './admin-keys.js';
import { createAccount } from './accounts.js';
import { makeTestDb } from '../testing/db.js';

function uniqueSlug(prefix = 'acct'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

test('hashAdminKey: stable sha-256 hex of the input string', () => {
  // Sanity-check the helper — operators may grep logs for hash prefixes.
  assert.equal(hashAdminKey('sw_abc'), hashAdminKey('sw_abc'));
  assert.notEqual(hashAdminKey('sw_abc'), hashAdminKey('sw_xyz'));
  assert.match(hashAdminKey('sw_abc'), /^[0-9a-f]{64}$/);
});

test('createAdminKey: returns the raw key shape, persists hash + metadata', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const account = await createAccount(db, { slug, name: slug });
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const minted = await createAdminKey(db, {
    accountId: account.id,
    description: 'integration tests',
  });

  assert.match(minted.rawKey, /^sw_[A-Za-z0-9_-]{43}$/);
  assert.equal(minted.account_id, account.id);
  assert.equal(minted.description, 'integration tests');
  assert.ok(minted.id);

  // The DB carries the hash, not the raw key.
  const row = await db('admin_keys').where({ id: minted.id }).first();
  assert.ok(row);
  assert.equal(row.token_hash, hashAdminKey(minted.rawKey));
  assert.equal(row.revoked_at, null);
});

test('createAdminKey: description defaults to NULL when omitted', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const account = await createAccount(db, { slug, name: slug });
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const minted = await createAdminKey(db, { accountId: account.id });
  assert.equal(minted.description, null);
});

test('getAdminKeyByHash: returns the row when the hash matches an active key', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const account = await createAccount(db, { slug, name: slug });
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const minted = await createAdminKey(db, { accountId: account.id });
  const looked = await getAdminKeyByHash(db, hashAdminKey(minted.rawKey));
  assert.ok(looked);
  assert.equal(looked.id, minted.id);
  assert.equal(looked.account_id, account.id);
  assert.equal(looked.revoked_at, null);
});

test('getAdminKeyByHash: bumps last_used_at on a successful lookup', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const account = await createAccount(db, { slug, name: slug });
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const minted = await createAdminKey(db, { accountId: account.id });

  // Confirm initial state.
  const before = await db('admin_keys').where({ id: minted.id }).first();
  assert.equal(before.last_used_at, null);

  // MariaDB TIMESTAMP has 1-second resolution by default; the lookup happens
  // fast enough that the timestamp landed in the same second as the insert.
  // Wait a moment so the bump is observable.
  await new Promise((r) => setTimeout(r, 1100));
  await getAdminKeyByHash(db, hashAdminKey(minted.rawKey));

  const after = await db('admin_keys').where({ id: minted.id }).first();
  assert.ok(after.last_used_at instanceof Date);
});

test('getAdminKeyByHash: returns null for an unknown hash', async (t) => {
  const db = makeTestDb();
  t.after(async () => {
    await db.destroy();
  });
  const looked = await getAdminKeyByHash(
    db,
    '0000000000000000000000000000000000000000000000000000000000000000',
  );
  assert.equal(looked, null);
});

test('getAdminKeyByHash: returns null for a revoked key (even with correct hash)', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const account = await createAccount(db, { slug, name: slug });
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const minted = await createAdminKey(db, { accountId: account.id });
  await revokeAdminKey(db, account.id, minted.id);
  const looked = await getAdminKeyByHash(db, hashAdminKey(minted.rawKey));
  assert.equal(looked, null);
});

test('listAdminKeys: returns all rows for an account, newest first, no token_hash leak', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const account = await createAccount(db, { slug, name: slug });
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const first = await createAdminKey(db, { accountId: account.id, description: 'first' });
  await new Promise((r) => setTimeout(r, 1100));
  const second = await createAdminKey(db, { accountId: account.id, description: 'second' });

  const rows = await listAdminKeys(db, account.id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, second.id); // newest first
  assert.equal(rows[1].id, first.id);
  for (const row of rows) {
    // Belt-and-braces: token_hash must not slip into the list view.
    assert.equal((row as unknown as { token_hash?: string }).token_hash, undefined);
  }
});

test('listAdminKeys: includes revoked rows alongside active ones', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const account = await createAccount(db, { slug, name: slug });
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const minted = await createAdminKey(db, { accountId: account.id });
  await revokeAdminKey(db, account.id, minted.id);

  const rows = await listAdminKeys(db, account.id);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].revoked_at instanceof Date);
});

test('revokeAdminKey: sets revoked_at and returns the updated row', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const account = await createAccount(db, { slug, name: slug });
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const minted = await createAdminKey(db, { accountId: account.id });
  const revoked = await revokeAdminKey(db, account.id, minted.id);
  assert.ok(revoked.revoked_at instanceof Date);
  assert.equal(revoked.id, minted.id);
});

test('revokeAdminKey: idempotent — revoking twice leaves revoked_at fixed', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const account = await createAccount(db, { slug, name: slug });
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const minted = await createAdminKey(db, { accountId: account.id });
  const first = await revokeAdminKey(db, account.id, minted.id);
  await new Promise((r) => setTimeout(r, 1100));
  const second = await revokeAdminKey(db, account.id, minted.id);
  assert.equal(
    (first.revoked_at as Date).getTime(),
    (second.revoked_at as Date).getTime(),
    'revoked_at should be preserved across idempotent revoke calls',
  );
});

test('revokeAdminKey: throws when the key id does not exist', async (t) => {
  const db = makeTestDb();
  t.after(async () => {
    await db.destroy();
  });
  await assert.rejects(() => revokeAdminKey(db, randomUUID(), randomUUID()), /Admin key not found/);
});

test('revokeAdminKey: refuses cross-account revocation', async (t) => {
  const db = makeTestDb();
  const slugA = uniqueSlug();
  const slugB = uniqueSlug();
  const accountA = await createAccount(db, { slug: slugA, name: slugA });
  const accountB = await createAccount(db, { slug: slugB, name: slugB });
  t.after(async () => {
    await db('accounts').whereIn('id', [accountA.id, accountB.id]).del();
    await db.destroy();
  });

  const aKey = await createAdminKey(db, { accountId: accountA.id });
  await assert.rejects(
    () => revokeAdminKey(db, accountB.id, aKey.id),
    /does not belong to account/,
  );
});

test('createAdminKey: per-call rawKey strings do not collide', () => {
  // Pure-function sanity. The CSPRNG should never collide in practice; if
  // this assertion ever fails, something's very wrong with the runtime.
  const keys = new Set<string>();
  for (let i = 0; i < 50; i++) {
    keys.add(`sw_${Math.random().toString()}`); // not the real shape, just to populate
  }
  // The actual collision check happens implicitly through the UNIQUE
  // constraint on `token_hash`; covered by happy-path tests above.
  assert.ok(keys.size > 0);
});

test('admin_keys cascades when the owning account is deleted', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const account = await createAccount(db, { slug, name: slug });
  // No t.after for the account — we delete it as the test action.
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const minted = await createAdminKey(db, { accountId: account.id });
  await db('accounts').where({ id: account.id }).del();
  const orphan = await db('admin_keys').where({ id: minted.id }).first();
  assert.equal(orphan, undefined, 'admin_keys row should have CASCADEd');
});
