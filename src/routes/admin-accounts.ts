import type { FastifyPluginAsync } from 'fastify';
import type { Knex } from 'knex';
import { createAccount, getAccountById, listAccounts } from '../services/accounts.js';
import { createAdminKey, listAdminKeys, revokeAdminKey } from '../services/admin-keys.js';
import { makeVerifyProvisioningBearer } from './admin-auth.js';

/**
 * `/admin/accounts/*` — provisioning-gated surface.
 *
 * All routes require the deployment `SW_PROVISIONING_KEY` as bearer. Used by
 * `site-walker-for-woo` to create accounts + mint the first admin key when a
 * WC subscription activates; self-hosters can hit the same surface or use
 * the CLI equivalents.
 */

const errorResponseSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    detail: { type: 'object', additionalProperties: true },
  },
  required: ['error'],
};

const accountSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    slug: { type: 'string' },
    name: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'slug', 'name', 'created_at', 'updated_at'],
};

const adminKeyRowSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    account_id: { type: 'string' },
    description: { type: ['string', 'null'] },
    last_used_at: { type: ['string', 'null'], format: 'date-time' },
    revoked_at: { type: ['string', 'null'], format: 'date-time' },
    created_at: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'account_id', 'description', 'last_used_at', 'revoked_at', 'created_at'],
};

export interface AdminAccountsPluginOpts {
  db: Knex;
}

const adminAccountsPlugin: FastifyPluginAsync<AdminAccountsPluginOpts> = async (fastify, opts) => {
  const { db } = opts;

  // Provisioning-gate every route in this plugin.
  fastify.addHook('preHandler', makeVerifyProvisioningBearer());

  // ---- GET /admin/accounts ----
  fastify.get(
    '/',
    {
      schema: {
        tags: ['admin'],
        summary: 'List accounts (provisioning)',
        description: 'Returns all accounts in the deployment.',
        security: [{ adminBearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              accounts: { type: 'array', items: accountSchema },
            },
            required: ['accounts'],
          },
          401: errorResponseSchema,
        },
      },
    },
    async () => {
      const accounts = await listAccounts(db);
      return { accounts };
    },
  );

  // ---- POST /admin/accounts ----
  fastify.post<{ Body: { slug?: unknown; name?: unknown } }>(
    '/',
    {
      schema: {
        tags: ['admin'],
        summary: 'Create an account (provisioning)',
        description:
          'Body: `{ slug, name }`. Slug must be 1–64 lowercase alphanumeric+hyphens. ' +
          'Returns the new account row. 409 if the slug is already taken.',
        security: [{ adminBearerAuth: [] }],
        response: {
          201: accountSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const body = req.body;
      if (!body || typeof body.slug !== 'string' || typeof body.name !== 'string') {
        return reply.status(400).send({
          error: 'validation_failed',
          detail: { message: 'Request body requires `slug` and `name` strings.' },
        });
      }
      try {
        const account = await createAccount(db, { slug: body.slug, name: body.name });
        return reply.status(201).send(account);
      } catch (err) {
        const msg = (err as Error).message;
        if (/Invalid slug/.test(msg)) {
          return reply.status(400).send({ error: 'validation_failed', detail: { message: msg } });
        }
        // mysql2 duplicate-key error wears its sleeve as ER_DUP_ENTRY.
        if (
          /ER_DUP_ENTRY/.test(msg) ||
          /Duplicate entry/.test(msg) ||
          /accounts_slug_unique/.test(msg)
        ) {
          return reply.status(409).send({
            error: 'conflict',
            detail: { message: `Account with slug "${body.slug}" already exists.` },
          });
        }
        throw err;
      }
    },
  );

  // ---- GET /admin/accounts/{accountId}/keys ----
  fastify.get<{ Params: { accountId: string } }>(
    '/:accountId/keys',
    {
      schema: {
        tags: ['admin'],
        summary: 'List admin keys for an account (provisioning)',
        description: 'Returns active and revoked admin keys. Token hashes are never returned.',
        security: [{ adminBearerAuth: [] }],
        params: {
          type: 'object',
          properties: { accountId: { type: 'string' } },
          required: ['accountId'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              admin_keys: { type: 'array', items: adminKeyRowSchema },
            },
            required: ['admin_keys'],
          },
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const account = await getAccountById(db, req.params.accountId);
      if (!account) {
        return reply.status(404).send({ error: 'not_found' });
      }
      const keys = await listAdminKeys(db, account.id);
      return { admin_keys: keys };
    },
  );

  // ---- POST /admin/accounts/{accountId}/keys ----
  fastify.post<{ Params: { accountId: string }; Body: { description?: unknown } }>(
    '/:accountId/keys',
    {
      schema: {
        tags: ['admin'],
        summary: 'Mint a new admin key (provisioning)',
        description:
          'Body: `{ description? }`. Returns the row metadata **plus the raw key** ' +
          'exactly once. The raw key is never retrievable again — the row stores only ' +
          'its sha-256 hash. Caller MUST capture `raw_key` from the response.',
        security: [{ adminBearerAuth: [] }],
        params: {
          type: 'object',
          properties: { accountId: { type: 'string' } },
          required: ['accountId'],
        },
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              account_id: { type: 'string' },
              description: { type: ['string', 'null'] },
              created_at: { type: 'string', format: 'date-time' },
              raw_key: {
                type: 'string',
                description: 'The bearer to use on /admin/chatbots/*. Shown ONCE; not retrievable.',
              },
            },
            required: ['id', 'account_id', 'description', 'created_at', 'raw_key'],
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const account = await getAccountById(db, req.params.accountId);
      if (!account) {
        return reply.status(404).send({ error: 'not_found' });
      }
      const description = typeof req.body?.description === 'string' ? req.body.description : null;
      const minted = await createAdminKey(db, { accountId: account.id, description });
      return reply.status(201).send({
        id: minted.id,
        account_id: minted.account_id,
        description: minted.description,
        created_at: minted.created_at,
        raw_key: minted.rawKey,
      });
    },
  );

  // ---- DELETE /admin/accounts/{accountId}/keys/{keyId} ----
  fastify.delete<{ Params: { accountId: string; keyId: string } }>(
    '/:accountId/keys/:keyId',
    {
      schema: {
        tags: ['admin'],
        summary: 'Revoke an admin key (provisioning)',
        description: 'Idempotent. Returns the updated key row. Cross-account revocation refused.',
        security: [{ adminBearerAuth: [] }],
        params: {
          type: 'object',
          properties: {
            accountId: { type: 'string' },
            keyId: { type: 'string' },
          },
          required: ['accountId', 'keyId'],
        },
        response: {
          200: adminKeyRowSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const account = await getAccountById(db, req.params.accountId);
      if (!account) {
        return reply.status(404).send({ error: 'not_found' });
      }
      try {
        const row = await revokeAdminKey(db, account.id, req.params.keyId);
        return reply.status(200).send(row);
      } catch (err) {
        const msg = (err as Error).message;
        if (/Admin key not found/.test(msg)) {
          return reply.status(404).send({ error: 'not_found' });
        }
        if (/does not belong to account/.test(msg)) {
          return reply.status(403).send({ error: 'cross_account' });
        }
        throw err;
      }
    },
  );
};

export default adminAccountsPlugin;
