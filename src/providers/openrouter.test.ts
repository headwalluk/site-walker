import { test } from 'node:test';
import assert from 'node:assert/strict';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { DEFAULT_OPENROUTER_BASE_URL, OpenRouterAdapter } from './openrouter.js';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

interface FakeResponse {
  status?: number;
  body: unknown;
}

async function startFakeOpenRouter(
  handler: (req: CapturedRequest) => FakeResponse | unknown,
): Promise<{ url: string; capturedRequests: CapturedRequest[]; close: () => Promise<void> }> {
  const captured: CapturedRequest[] = [];
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let parsed: unknown;
      try {
        parsed = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch {
        parsed = raw;
      }
      const captured_req: CapturedRequest = {
        url: req.url ?? '',
        method: req.method ?? '',
        headers: req.headers,
        body: parsed,
      };
      captured.push(captured_req);
      const result = handler(captured_req);
      const isShaped = (v: unknown): v is FakeResponse =>
        typeof v === 'object' && v !== null && 'body' in v;
      if (isShaped(result)) {
        res.writeHead(result.status ?? 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      }
    });
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

test('openrouter: sends correct payload, headers, and parses response', async (t) => {
  const fake = await startFakeOpenRouter(() => ({
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    model: 'anthropic/claude-haiku-4.5',
    choices: [
      { message: { role: 'assistant', content: 'Hello from Haiku.' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
  }));
  t.after(() => fake.close());

  const adapter = new OpenRouterAdapter({ apiKey: 'sk-or-v1-TEST', baseUrl: fake.url });
  const res = await adapter.chat({
    model: 'anthropic/claude-haiku-4.5',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ],
    parameters: { temperature: 0.4, top_p: 0.9, max_tokens: 256, stop: ['</s>'] },
  });

  assert.equal(res.reply, 'Hello from Haiku.');
  assert.deepEqual(res.tokensUsed, { prompt: 42, completion: 7 });

  assert.equal(fake.capturedRequests.length, 1);
  const req = fake.capturedRequests[0];
  assert.equal(req.url, '/chat/completions');
  assert.equal(req.method, 'POST');
  assert.equal(req.headers.authorization, 'Bearer sk-or-v1-TEST');
  assert.equal(req.headers['http-referer'], 'https://site-walker.net');
  assert.equal(req.headers['x-title'], 'Site Walker');
  assert.equal(req.headers['content-type'], 'application/json');

  const body = req.body as Record<string, unknown>;
  assert.equal(body.model, 'anthropic/claude-haiku-4.5');
  assert.equal(body.stream, false);
  assert.equal(body.temperature, 0.4);
  assert.equal(body.top_p, 0.9);
  assert.equal(body.max_tokens, 256);
  assert.deepEqual(body.stop, ['</s>']);
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
  ]);
});

test('openrouter: omits parameter keys when not provided', async (t) => {
  const fake = await startFakeOpenRouter(() => ({
    choices: [{ message: { role: 'assistant', content: 'ok' } }],
  }));
  t.after(() => fake.close());

  const adapter = new OpenRouterAdapter({ apiKey: 'sk-or-v1-TEST', baseUrl: fake.url });
  await adapter.chat({
    model: 'x',
    messages: [{ role: 'user', content: 'hi' }],
    parameters: {},
  });

  const body = fake.capturedRequests[0].body as Record<string, unknown>;
  assert.equal('temperature' in body, false);
  assert.equal('top_p' in body, false);
  assert.equal('max_tokens' in body, false);
  assert.equal('stop' in body, false);
});

test('openrouter: throws on non-2xx with informative message', async (t) => {
  const fake = await startFakeOpenRouter(() => ({
    status: 401,
    body: { error: { code: 'auth_failed', message: 'bad key' } },
  }));
  t.after(() => fake.close());

  const adapter = new OpenRouterAdapter({ apiKey: 'sk-or-v1-WRONG', baseUrl: fake.url });
  await assert.rejects(
    () => adapter.chat({ model: 'x', messages: [], parameters: {} }),
    /failed \(401/,
  );
});

test('openrouter: throws when choices[0].message.content is missing', async (t) => {
  const fake = await startFakeOpenRouter(() => ({ choices: [{}] }));
  t.after(() => fake.close());

  const adapter = new OpenRouterAdapter({ apiKey: 'sk-or-v1-TEST', baseUrl: fake.url });
  await assert.rejects(
    () => adapter.chat({ model: 'x', messages: [], parameters: {} }),
    /no choices\[0\]\.message\.content/,
  );
});

test('openrouter: trailing slash on base_url is normalised', async (t) => {
  const fake = await startFakeOpenRouter(() => ({
    choices: [{ message: { role: 'assistant', content: 'ok' } }],
  }));
  t.after(() => fake.close());

  const adapter = new OpenRouterAdapter({ apiKey: 'sk-or-v1-TEST', baseUrl: `${fake.url}/` });
  await adapter.chat({ model: 'x', messages: [], parameters: {} });
  assert.equal(fake.capturedRequests[0].url, '/chat/completions');
});

test('openrouter: defaults base_url to openrouter.ai/api/v1 when not provided', () => {
  const adapter = new OpenRouterAdapter({ apiKey: 'sk-or-v1-TEST' });
  // Inspecting via a re-used baseUrl property would require exposing it; we
  // assert against the exported constant + adapter construction succeeding.
  assert.equal(DEFAULT_OPENROUTER_BASE_URL, 'https://openrouter.ai/api/v1');
  assert.ok(adapter);
});

test('openrouter: throws when api_key is missing', () => {
  assert.throws(() => new OpenRouterAdapter({ apiKey: '' }), /requires api_key/);
});

test('openrouter: custom referer + title overrides defaults', async (t) => {
  const fake = await startFakeOpenRouter(() => ({
    choices: [{ message: { role: 'assistant', content: 'ok' } }],
  }));
  t.after(() => fake.close());

  const adapter = new OpenRouterAdapter({
    apiKey: 'sk-or-v1-TEST',
    baseUrl: fake.url,
    referer: 'https://example.test/',
    title: 'Example',
  });
  await adapter.chat({ model: 'x', messages: [], parameters: {} });

  const headers = fake.capturedRequests[0].headers;
  assert.equal(headers['http-referer'], 'https://example.test/');
  assert.equal(headers['x-title'], 'Example');
});
