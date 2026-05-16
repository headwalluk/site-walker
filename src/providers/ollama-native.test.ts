import { test } from 'node:test';
import assert from 'node:assert/strict';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { OllamaNativeAdapter } from './ollama-native.js';

interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
}

interface FakeResponse {
  status?: number;
  body: unknown;
}

async function startFakeOllama(
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

test('ollama-native: sends correct payload and parses response', async (t) => {
  const fake = await startFakeOllama(() => ({
    model: 'qwen2:1.5b',
    message: { role: 'assistant', content: 'Hello from the model.' },
    prompt_eval_count: 12,
    eval_count: 5,
    done: true,
  }));
  t.after(() => fake.close());

  const adapter = new OllamaNativeAdapter(fake.url);
  const res = await adapter.chat({
    model: 'qwen2:1.5b',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ],
    parameters: { temperature: 0.5, top_p: 0.9, max_tokens: 128, stop: ['</s>'] },
  });

  assert.equal(res.reply, 'Hello from the model.');
  assert.deepEqual(res.tokensUsed, { prompt: 12, completion: 5 });

  assert.equal(fake.capturedRequests.length, 1);
  const req = fake.capturedRequests[0];
  assert.equal(req.url, '/api/chat');
  assert.equal(req.method, 'POST');
  const body = req.body as Record<string, unknown>;
  assert.equal(body.model, 'qwen2:1.5b');
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
  ]);
  assert.equal(body.stream, false);
  assert.deepEqual(body.options, {
    temperature: 0.5,
    top_p: 0.9,
    num_predict: 128,
    stop: ['</s>'],
  });
});

test('ollama-native: omits options when parameters empty', async (t) => {
  const fake = await startFakeOllama(() => ({
    message: { role: 'assistant', content: 'ok' },
  }));
  t.after(() => fake.close());

  const adapter = new OllamaNativeAdapter(fake.url);
  await adapter.chat({ model: 'x', messages: [], parameters: {} });

  const body = fake.capturedRequests[0].body as Record<string, unknown>;
  assert.equal('options' in body, false);
});

test('ollama-native: throws on non-200', async (t) => {
  const fake = await startFakeOllama(() => ({ status: 500, body: { error: 'boom' } }));
  t.after(() => fake.close());

  const adapter = new OllamaNativeAdapter(fake.url);
  await assert.rejects(
    () => adapter.chat({ model: 'x', messages: [], parameters: {} }),
    /failed \(500/,
  );
});

test('ollama-native: throws when response missing message.content', async (t) => {
  const fake = await startFakeOllama(() => ({ done: true }));
  t.after(() => fake.close());

  const adapter = new OllamaNativeAdapter(fake.url);
  await assert.rejects(
    () => adapter.chat({ model: 'x', messages: [], parameters: {} }),
    /no message\.content/,
  );
});

test('ollama-native: trailing slash on base_url is normalised', async (t) => {
  const fake = await startFakeOllama(() => ({
    message: { role: 'assistant', content: 'ok' },
  }));
  t.after(() => fake.close());

  const adapter = new OllamaNativeAdapter(`${fake.url}/`);
  await adapter.chat({ model: 'x', messages: [], parameters: {} });
  assert.equal(fake.capturedRequests[0].url, '/api/chat');
});
