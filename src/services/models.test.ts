import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import {
  defaultHeadroom,
  resolveModel,
  setContextWindow,
  setModel,
  setParameters,
  validateContextBudget,
  validateRegistryAgainstChatbots,
} from './models.js';
import { getChatbotBySlug } from './chatbots.js';
import { createProvider, createProviderModel } from './providers.js';
import { makeTestDb, seedAccountAndChatbot } from '../testing/db.js';

function uniqueSlug(): string {
  return `test-${randomUUID().slice(0, 8)}`;
}

/**
 * Each test gets its own provider + model rows so concurrent test
 * execution doesn't collide on unique provider names. Returns the
 * provider name so the test can compose the `provider/model` slug.
 */
async function seedProvider(
  db: Knex,
  opts: { metered?: boolean } = {},
): Promise<{ providerName: string; providerId: number }> {
  const providerName = `pi-${randomUUID().slice(0, 8)}`;
  const provider = await createProvider(db, {
    name: providerName,
    protocol: 'ollama-native',
    base_url: 'http://test.invalid:11434',
    is_local: !opts.metered,
    is_metered: opts.metered ?? false,
  });
  await createProviderModel(db, {
    provider_id: provider.id,
    model_slug: 'qwen2:1.5b',
    context_window: 4096,
  });
  return { providerName, providerId: provider.id };
}

test('setModel rejects when provider is not in the registry', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account } = await seedAccountAndChatbot(db, slug);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  await assert.rejects(
    () => setModel(db, slug, 'no-such-provider/qwen2:1.5b'),
    /does not resolve against the provider registry/,
  );
});

test('setModel persists model_slug when the slug resolves against the DB', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account } = await seedAccountAndChatbot(db, slug);
  const { providerName } = await seedProvider(db);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db('providers').where({ name: providerName }).del();
    await db.destroy();
  });

  const updated = await setModel(db, slug, `${providerName}/qwen2:1.5b`);
  assert.equal(updated.model_slug, `${providerName}/qwen2:1.5b`);
});

test('setParameters rejects unknown keys', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account } = await seedAccountAndChatbot(db, slug);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  await assert.rejects(() => setParameters(db, slug, { frequency_penalty: 0.5 }));
});

test('setParameters rejects out-of-range values', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account } = await seedAccountAndChatbot(db, slug);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  await assert.rejects(() => setParameters(db, slug, { temperature: 3 }));
});

test('setParameters persists a valid object', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account } = await seedAccountAndChatbot(db, slug);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const updated = await setParameters(db, slug, { temperature: 0.7, max_tokens: 256 });
  assert.deepEqual(updated.model_parameters, { temperature: 0.7, max_tokens: 256 });
});

test('setContextWindow rejects non-positive integers', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account } = await seedAccountAndChatbot(db, slug);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  await assert.rejects(() => setContextWindow(db, slug, 0), /positive integer/);
  await assert.rejects(() => setContextWindow(db, slug, -100), /positive integer/);
  await assert.rejects(() => setContextWindow(db, slug, 1.5), /positive integer/);
});

test('setContextWindow persists a positive integer', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account } = await seedAccountAndChatbot(db, slug);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const updated = await setContextWindow(db, slug, 32000);
  assert.equal(updated.model_context_window, 32000);
});

test('resolveModel happy path joins through the DB registry', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account } = await seedAccountAndChatbot(db, slug);
  const { providerName } = await seedProvider(db);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db('providers').where({ name: providerName }).del();
    await db.destroy();
  });

  await setModel(db, slug, `${providerName}/qwen2:1.5b`);
  await setParameters(db, slug, { temperature: 0.5 });

  const row = await getChatbotBySlug(db, slug);
  assert.ok(row);
  const resolved = await resolveModel(db, row);
  assert.equal(resolved.modelSlug, `${providerName}/qwen2:1.5b`);
  assert.equal(resolved.provider.name, providerName);
  assert.equal(resolved.model, 'qwen2:1.5b');
  assert.deepEqual(resolved.parameters, { temperature: 0.5 });
  // contextWindow falls back to provider_models.context_window when the
  // chatbot's own override is NULL.
  assert.equal(resolved.contextWindow, 4096);
});

test('resolveModel: chatbot override wins over provider_models.context_window', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account } = await seedAccountAndChatbot(db, slug);
  const { providerName } = await seedProvider(db);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db('providers').where({ name: providerName }).del();
    await db.destroy();
  });

  await setModel(db, slug, `${providerName}/qwen2:1.5b`);
  await setContextWindow(db, slug, 2048);

  const row = await getChatbotBySlug(db, slug);
  assert.ok(row);
  const resolved = await resolveModel(db, row);
  assert.equal(resolved.contextWindow, 2048);
});

test('resolveModel throws when chatbot has no model_slug', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account } = await seedAccountAndChatbot(db, slug);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const row = await getChatbotBySlug(db, slug);
  assert.ok(row);
  await assert.rejects(() => resolveModel(db, row), /no model_slug set/);
});

test('resolveModel throws when the registered provider/model row is missing', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account } = await seedAccountAndChatbot(db, slug);
  const { providerName } = await seedProvider(db);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    // Note: provider deleted before resolveModel so the lookup misses.
    await db('providers').where({ name: providerName }).del();
    await db.destroy();
  });

  await setModel(db, slug, `${providerName}/qwen2:1.5b`);
  // Now wipe the provider entirely (CASCADE drops the model row).
  await db('providers').where({ name: providerName }).del();

  const row = await getChatbotBySlug(db, slug);
  assert.ok(row);
  await assert.rejects(
    () => resolveModel(db, row),
    /does not resolve against the provider registry/,
  );
});

test('validateContextBudget: under budget passes', () => {
  validateContextBudget({
    chatbotSlug: 'x',
    modelSlug: 'pi/qwen2',
    contextWindow: 32000,
    promptTokens: 1000,
  });
});

test('validateContextBudget: insufficient headroom throws documented error shape', () => {
  assert.throws(
    () =>
      validateContextBudget({
        chatbotSlug: 'foobar.org',
        modelSlug: 'pi/qwen2:1.5b',
        contextWindow: 32000,
        promptTokens: 31900,
      }),
    /system blocks for chatbot "foobar.org" total ~31900 tokens.*model_context_window for "pi\/qwen2:1\.5b" is 32000.*~100 for conversation history \+ response/s,
  );
});

test('defaultHeadroom: 12.5% of context window with 512 floor', () => {
  assert.equal(defaultHeadroom(1024), 512);
  assert.equal(defaultHeadroom(32000), 4000);
  assert.equal(defaultHeadroom(8000), 1000);
});

test('validateRegistryAgainstChatbots: passes when every model_slug resolves', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account } = await seedAccountAndChatbot(db, slug);
  const { providerName } = await seedProvider(db);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db('providers').where({ name: providerName }).del();
    await db.destroy();
  });

  await setModel(db, slug, `${providerName}/qwen2:1.5b`);
  await validateRegistryAgainstChatbots(db, [slug]);
});

test('validateRegistryAgainstChatbots: fails when a chatbot references a missing provider', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account } = await seedAccountAndChatbot(db, slug);
  const { providerName } = await seedProvider(db);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db('providers').where({ name: providerName }).del();
    await db.destroy();
  });

  await setModel(db, slug, `${providerName}/qwen2:1.5b`);
  // Wipe the provider; the chatbot's model_slug now dangles.
  await db('providers').where({ name: providerName }).del();

  await assert.rejects(
    () => validateRegistryAgainstChatbots(db, [slug]),
    /does not resolve against the provider registry/,
  );
});
