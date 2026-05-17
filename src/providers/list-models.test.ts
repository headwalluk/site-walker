import { test } from 'node:test';
import assert from 'node:assert/strict';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { ProviderEntry } from '../config/site-walker-config.js';
import { listProviderModels } from './list-models.js';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

async function startFakeProvider(
  responseBody: unknown,
  status = 200,
): Promise<{ url: string; capturedRequests: CapturedRequest[]; close: () => Promise<void> }> {
  const captured: CapturedRequest[] = [];
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    captured.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseBody));
  });
  server.listen(0);
  await once(server, 'listening');
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    capturedRequests: captured,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

test('listProviderModels: ollama-native maps /api/tags to ModelListing[]', async (t) => {
  const fake = await startFakeProvider({
    models: [
      { name: 'qwen2:1.5b' },
      { name: 'llama3.2:3b' },
      {
        /* malformed entry without a name — should be skipped */
      },
    ],
  });
  t.after(() => fake.close());

  const entry: ProviderEntry = {
    name: 'pi',
    protocol: 'ollama-native',
    base_url: fake.url,
  };
  const models = await listProviderModels(entry);

  assert.equal(models.length, 2);
  assert.equal(models[0].id, 'qwen2:1.5b');
  assert.equal(models[1].id, 'llama3.2:3b');
  assert.equal(fake.capturedRequests[0].url, '/api/tags');
  assert.equal(fake.capturedRequests[0].method, 'GET');
});

test('listProviderModels: ollama-native requires base_url', async () => {
  const entry: ProviderEntry = { name: 'pi', protocol: 'ollama-native' };
  await assert.rejects(() => listProviderModels(entry), /requires base_url/);
});

test('listProviderModels: openrouter maps /models response and forwards api_key', async (t) => {
  const fake = await startFakeProvider({
    data: [
      { id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5', context_length: 200000 },
      { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', context_length: 128000 },
      { id: 'some/no-context-model', name: 'No Context Reported' },
      {
        /* malformed entry */
      },
    ],
  });
  t.after(() => fake.close());

  const entry: ProviderEntry = {
    name: 'openrouter',
    protocol: 'openrouter',
    base_url: fake.url,
    api_key: 'sk-or-v1-TEST',
  };
  const models = await listProviderModels(entry);

  assert.equal(models.length, 3);
  assert.deepEqual(models[0], {
    id: 'anthropic/claude-haiku-4.5',
    label: 'Claude Haiku 4.5',
    contextWindow: 200000,
  });
  assert.deepEqual(models[2], { id: 'some/no-context-model', label: 'No Context Reported' });

  const req = fake.capturedRequests[0];
  assert.equal(req.url, '/models');
  assert.equal(req.method, 'GET');
  assert.equal(req.headers.authorization, 'Bearer sk-or-v1-TEST');
});

test('listProviderModels: openrouter skips Authorization when api_key absent', async (t) => {
  const fake = await startFakeProvider({ data: [{ id: 'free/model' }] });
  t.after(() => fake.close());

  const entry: ProviderEntry = {
    name: 'openrouter',
    protocol: 'openrouter',
    base_url: fake.url,
  };
  await listProviderModels(entry);
  assert.equal(fake.capturedRequests[0].headers.authorization, undefined);
});

test('listProviderModels: throws for protocols that have no discovery surface yet', async () => {
  await assert.rejects(
    () =>
      listProviderModels({
        name: 'anthropic-direct',
        protocol: 'anthropic',
        api_key: 'sk-ant-x',
      }),
    /doesn't yet support model listing/,
  );
});

test('listProviderModels: surfaces upstream non-2xx errors', async (t) => {
  const fake = await startFakeProvider({ error: 'nope' }, 503);
  t.after(() => fake.close());

  const entry: ProviderEntry = {
    name: 'cortex',
    protocol: 'ollama-native',
    base_url: fake.url,
  };
  await assert.rejects(() => listProviderModels(entry), /failed \(503/);
});
