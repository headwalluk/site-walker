import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from './server.js';

test('GET / returns ok payload with service and version', async () => {
  const fastify = buildServer({ logger: false });
  try {
    const response = await fastify.inject({ method: 'GET', url: '/' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      ok: true,
      service: 'site-walker',
      version: '0.2.0',
    });
  } finally {
    await fastify.close();
  }
});
