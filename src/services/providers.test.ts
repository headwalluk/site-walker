import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createProvider,
  createProviderModel,
  deleteProvider,
  deleteProviderModel,
  findProviderModel,
  getProviderByName,
  listProviderModelsForProvider,
  listProviders,
} from './providers.js';
import { makeTestDb } from '../testing/db.js';

function uniqueName(prefix = 'test'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

test('createProvider + getProviderByName roundtrip', async (t) => {
  const db = makeTestDb();
  const name = uniqueName();
  t.after(async () => {
    await db('providers').where({ name }).del();
    await db.destroy();
  });

  const created = await createProvider(db, {
    name,
    protocol: 'ollama-native',
    base_url: 'http://cortex.local:8000',
    is_local: true,
  });
  assert.equal(created.name, name);
  assert.equal(created.protocol, 'ollama-native');
  assert.equal(created.is_local, true);
  // is_metered defaults to !is_local when not given.
  assert.equal(created.is_metered, false);

  const fetched = await getProviderByName(db, name);
  assert.ok(fetched);
  assert.equal(fetched.id, created.id);
});

test('createProvider: is_metered defaults to true for non-local providers', async (t) => {
  const db = makeTestDb();
  const name = uniqueName();
  t.after(async () => {
    await db('providers').where({ name }).del();
    await db.destroy();
  });
  const created = await createProvider(db, {
    name,
    protocol: 'openrouter',
    base_url: 'https://openrouter.ai/api/v1',
  });
  assert.equal(created.is_local, false);
  assert.equal(created.is_metered, true);
});

test('createProvider: explicit is_metered overrides the !is_local default', async (t) => {
  const db = makeTestDb();
  const name = uniqueName();
  t.after(async () => {
    await db('providers').where({ name }).del();
    await db.destroy();
  });
  const created = await createProvider(db, {
    name,
    protocol: 'ollama-native',
    base_url: 'http://cortex.local:8000',
    is_local: true,
    is_metered: true,
  });
  assert.equal(created.is_metered, true);
});

test('createProvider rejects invalid name', async (t) => {
  const db = makeTestDb();
  t.after(async () => {
    await db.destroy();
  });
  await assert.rejects(
    () =>
      createProvider(db, {
        name: 'Bad_Name',
        protocol: 'ollama-native',
        base_url: 'http://x',
      }),
    /Invalid provider name/,
  );
});

test('createProvider rejects unsupported protocol', async (t) => {
  const db = makeTestDb();
  t.after(async () => {
    await db.destroy();
  });
  await assert.rejects(
    () =>
      createProvider(db, {
        name: uniqueName(),
        protocol: 'imaginary-protocol',
        base_url: 'http://x',
      }),
    /Invalid protocol/,
  );
});

test('createProvider rejects empty base_url', async (t) => {
  const db = makeTestDb();
  t.after(async () => {
    await db.destroy();
  });
  await assert.rejects(
    () =>
      createProvider(db, {
        name: uniqueName(),
        protocol: 'ollama-native',
        base_url: '',
      }),
    /base_url/,
  );
});

test('listProviders returns rows in alphabetical order', async (t) => {
  const db = makeTestDb();
  const slugA = `aaa-${randomUUID().slice(0, 8)}`;
  const slugB = `bbb-${randomUUID().slice(0, 8)}`;
  await createProvider(db, { name: slugB, protocol: 'openrouter', base_url: 'https://b.test' });
  await createProvider(db, { name: slugA, protocol: 'openrouter', base_url: 'https://a.test' });
  t.after(async () => {
    await db('providers').whereIn('name', [slugA, slugB]).del();
    await db.destroy();
  });
  const rows = await listProviders(db);
  const ours = rows.filter((r) => r.name === slugA || r.name === slugB);
  assert.equal(ours.length, 2);
  assert.equal(ours[0].name, slugA);
  assert.equal(ours[1].name, slugB);
});

test('deleteProvider cascades through provider_models and returns the count', async (t) => {
  const db = makeTestDb();
  const name = uniqueName();
  t.after(async () => {
    await db('providers').where({ name }).del();
    await db.destroy();
  });
  const provider = await createProvider(db, {
    name,
    protocol: 'openrouter',
    base_url: 'https://x.test',
  });
  await createProviderModel(db, {
    provider_id: provider.id,
    model_slug: 'foo/bar',
    context_window: 4096,
  });
  await createProviderModel(db, {
    provider_id: provider.id,
    model_slug: 'foo/baz',
    context_window: 8192,
  });
  const counts = await deleteProvider(db, name);
  assert.equal(counts.models, 2);
  assert.equal(await getProviderByName(db, name), null);
});

test('deleteProvider throws when the provider does not exist', async (t) => {
  const db = makeTestDb();
  t.after(async () => {
    await db.destroy();
  });
  await assert.rejects(() => deleteProvider(db, 'no-such-provider-xyz'), /Provider not found/);
});

test('createProviderModel + listProviderModelsForProvider roundtrip', async (t) => {
  const db = makeTestDb();
  const name = uniqueName();
  t.after(async () => {
    await db('providers').where({ name }).del();
    await db.destroy();
  });
  const provider = await createProvider(db, {
    name,
    protocol: 'openrouter',
    base_url: 'https://x.test',
  });
  await createProviderModel(db, {
    provider_id: provider.id,
    model_slug: 'anthropic/claude-haiku-4.5',
    context_window: 200000,
    input_per_million_usd: 1.0,
    output_per_million_usd: 5.0,
  });
  const rows = await listProviderModelsForProvider(db, provider.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model_slug, 'anthropic/claude-haiku-4.5');
  assert.equal(rows[0].context_window, 200000);
  // mysql2 returns DECIMAL as string — compare loosely.
  assert.equal(Number(rows[0].input_per_million_usd), 1.0);
  assert.equal(Number(rows[0].output_per_million_usd), 5.0);
  assert.equal(rows[0].is_available, true);
});

test('createProviderModel: pricing columns default to NULL', async (t) => {
  const db = makeTestDb();
  const name = uniqueName();
  t.after(async () => {
    await db('providers').where({ name }).del();
    await db.destroy();
  });
  const provider = await createProvider(db, {
    name,
    protocol: 'ollama-native',
    base_url: 'http://x',
    is_local: true,
  });
  const model = await createProviderModel(db, {
    provider_id: provider.id,
    model_slug: 'qwen2:1.5b',
    context_window: 4096,
  });
  assert.equal(model.input_per_million_usd, null);
  assert.equal(model.output_per_million_usd, null);
});

test('createProviderModel rejects empty model_slug', async (t) => {
  const db = makeTestDb();
  const name = uniqueName();
  t.after(async () => {
    await db('providers').where({ name }).del();
    await db.destroy();
  });
  const provider = await createProvider(db, {
    name,
    protocol: 'openrouter',
    base_url: 'https://x.test',
  });
  await assert.rejects(
    () =>
      createProviderModel(db, {
        provider_id: provider.id,
        model_slug: '',
        context_window: 4096,
      }),
    /model_slug/,
  );
});

test('createProviderModel rejects non-positive context_window', async (t) => {
  const db = makeTestDb();
  const name = uniqueName();
  t.after(async () => {
    await db('providers').where({ name }).del();
    await db.destroy();
  });
  const provider = await createProvider(db, {
    name,
    protocol: 'openrouter',
    base_url: 'https://x.test',
  });
  await assert.rejects(
    () =>
      createProviderModel(db, {
        provider_id: provider.id,
        model_slug: 'foo/bar',
        context_window: 0,
      }),
    /positive integer/,
  );
  await assert.rejects(
    () =>
      createProviderModel(db, {
        provider_id: provider.id,
        model_slug: 'foo/baz',
        context_window: -10,
      }),
    /positive integer/,
  );
});

test('deleteProviderModel removes the row', async (t) => {
  const db = makeTestDb();
  const name = uniqueName();
  t.after(async () => {
    await db('providers').where({ name }).del();
    await db.destroy();
  });
  const provider = await createProvider(db, {
    name,
    protocol: 'openrouter',
    base_url: 'https://x.test',
  });
  await createProviderModel(db, {
    provider_id: provider.id,
    model_slug: 'foo/bar',
    context_window: 4096,
  });
  await deleteProviderModel(db, name, 'foo/bar');
  const rows = await listProviderModelsForProvider(db, provider.id);
  assert.equal(rows.length, 0);
});

test('deleteProviderModel throws when the model is not present', async (t) => {
  const db = makeTestDb();
  const name = uniqueName();
  t.after(async () => {
    await db('providers').where({ name }).del();
    await db.destroy();
  });
  await createProvider(db, {
    name,
    protocol: 'openrouter',
    base_url: 'https://x.test',
  });
  await assert.rejects(
    () => deleteProviderModel(db, name, 'no-such-model'),
    /Provider model not found/,
  );
});

test('findProviderModel returns provider + model on a hit', async (t) => {
  const db = makeTestDb();
  const name = uniqueName();
  t.after(async () => {
    await db('providers').where({ name }).del();
    await db.destroy();
  });
  const provider = await createProvider(db, {
    name,
    protocol: 'openrouter',
    base_url: 'https://x.test',
  });
  await createProviderModel(db, {
    provider_id: provider.id,
    model_slug: 'anthropic/claude-haiku-4.5',
    context_window: 200000,
    input_per_million_usd: 1.0,
    output_per_million_usd: 5.0,
  });
  const resolved = await findProviderModel(db, name, 'anthropic/claude-haiku-4.5');
  assert.ok(resolved);
  assert.equal(resolved.provider.name, name);
  assert.equal(resolved.provider.is_metered, true);
  assert.equal(resolved.model.model_slug, 'anthropic/claude-haiku-4.5');
  assert.equal(resolved.model.context_window, 200000);
});

test('findProviderModel returns null when the provider is unknown', async (t) => {
  const db = makeTestDb();
  t.after(async () => {
    await db.destroy();
  });
  const resolved = await findProviderModel(db, 'no-such-provider', 'anything');
  assert.equal(resolved, null);
});

test('findProviderModel returns null when the model is not registered against this provider', async (t) => {
  const db = makeTestDb();
  const name = uniqueName();
  t.after(async () => {
    await db('providers').where({ name }).del();
    await db.destroy();
  });
  await createProvider(db, {
    name,
    protocol: 'openrouter',
    base_url: 'https://x.test',
  });
  const resolved = await findProviderModel(db, name, 'unknown/model');
  assert.equal(resolved, null);
});
