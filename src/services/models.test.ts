import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ProviderEntry, ProviderRegistry } from '../config/site-walker-config.js';
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
import { makeTestDb, seedAccountAndChatbot } from '../testing/db.js';

function uniqueSlug(): string {
  return `test-${randomUUID().slice(0, 8)}`;
}

function fakeRegistry(entries: ProviderEntry[] = []): ProviderRegistry {
  return {
    configPath: '/tmp/fake.toml',
    providers: new Map(entries.map((e) => [e.name, e])),
  };
}

const piEntry: ProviderEntry = {
  name: 'pi',
  protocol: 'ollama-native',
  base_url: 'http://rpi.local:11434',
};

test('setModel rejects when provider is not in the registry', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account } = await seedAccountAndChatbot(db, slug);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  await assert.rejects(
    () => setModel(db, slug, 'nope/qwen2:1.5b', fakeRegistry([piEntry])),
    /Provider "nope".*not defined/,
  );
});

test('setModel persists model_slug when provider is known', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account } = await seedAccountAndChatbot(db, slug);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const updated = await setModel(db, slug, 'pi/qwen2:1.5b', fakeRegistry([piEntry]));
  assert.equal(updated.model_slug, 'pi/qwen2:1.5b');
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

test('resolveModel happy path', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account } = await seedAccountAndChatbot(db, slug);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const registry = fakeRegistry([piEntry]);
  await setModel(db, slug, 'pi/qwen2:1.5b', registry);
  await setParameters(db, slug, { temperature: 0.5 });

  const row = await getChatbotBySlug(db, slug);
  assert.ok(row);
  const resolved = resolveModel(row, registry);
  assert.equal(resolved.modelSlug, 'pi/qwen2:1.5b');
  assert.equal(resolved.provider.name, 'pi');
  assert.equal(resolved.model, 'qwen2:1.5b');
  assert.deepEqual(resolved.parameters, { temperature: 0.5 });
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
  assert.throws(() => resolveModel(row, fakeRegistry([piEntry])), /no model_slug set/);
});

test('resolveModel throws when registry is missing the provider', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account } = await seedAccountAndChatbot(db, slug);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  await setModel(db, slug, 'pi/qwen2:1.5b', fakeRegistry([piEntry]));
  const row = await getChatbotBySlug(db, slug);
  assert.ok(row);
  assert.throws(() => resolveModel(row, fakeRegistry([])), /not defined/);
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
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const registry = fakeRegistry([piEntry]);
  await setModel(db, slug, 'pi/qwen2:1.5b', registry);
  await validateRegistryAgainstChatbots(db, registry, [slug]);
});

test('validateRegistryAgainstChatbots: fails when a chatbot references a missing provider', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account } = await seedAccountAndChatbot(db, slug);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const registry = fakeRegistry([piEntry]);
  await setModel(db, slug, 'pi/qwen2:1.5b', registry);

  await assert.rejects(
    () => validateRegistryAgainstChatbots(db, fakeRegistry([]), [slug]),
    /references provider "pi".*not defined/s,
  );
});
