import path from 'node:path';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Knex } from 'knex';
import { encrypt } from '../utils/crypto.js';
import { loadEncryptionKey } from '../config/secrets.js';
import {
  addOrigin,
  createChatbot,
  deleteChatbot,
  findChatbotByOrigin,
  getChatbotBySlug,
  listChatbots,
  listOrigins,
  normaliseOrigin,
  removeOrigin,
  setPersona,
  setWelcomeMessage,
  type Chatbot,
} from '../services/chatbots.js';
import {
  setChatbotGeoCountries,
  setChatbotGeoMode,
  getChatbotGeoSummary,
} from '../services/geo.js';
import { resolveModel, setContextWindow, setModel, setParameters } from '../services/models.js';
import { getChatbotUsage, parseSinceDuration } from '../services/cost.js';
import { DEFAULT_DATA_DIR } from '../services/system-blocks.js';
import { env } from '../config/env.js';
import { makeVerifyAccountAdminBearer } from './admin-auth.js';

/**
 * `/admin/chatbots/*` — account-admin-gated surface.
 *
 * Every route requires an admin key whose `account_id` matches the resolved
 * chatbot. The `verifyAccountAdminBearer` middleware sets
 * `req.adminContext.accountId` on success; every route handler runs
 * `resolveChatbotForAccount` before doing any work, which yields a
 * coherent `403 cross_account` if a key tries to reach across accounts.
 */

const errorResponseSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    detail: { type: 'object', additionalProperties: true },
  },
  required: ['error'],
};

const chatbotSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    account_id: { type: 'string' },
    slug: { type: 'string' },
    name: { type: 'string' },
    welcome_message: { type: ['string', 'null'] },
    persona: { type: ['string', 'null'] },
    model_slug: { type: ['string', 'null'] },
    model_parameters: { type: ['object', 'null'], additionalProperties: true },
    model_context_window: { type: ['integer', 'null'] },
    // M20: DECIMAL columns are strings out of mysql2; nullable.
    daily_budget_usd: { type: ['string', 'null'] },
    session_budget_usd: { type: ['string', 'null'] },
    handoff_threshold_pct: { type: 'integer' },
    handoff_webhook_url: { type: ['string', 'null'] },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'account_id', 'slug', 'name', 'created_at', 'updated_at'],
};

const originRowSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    chatbot_id: { type: 'integer' },
    origin: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'chatbot_id', 'origin', 'created_at'],
};

/** PERSONA is reserved — it has its own DB column, not a disk block. */
const BLOCK_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const RESERVED_BLOCK_NAMES = new Set(['PERSONA']);
const MAX_BLOCK_BYTES = 64 * 1024;

function isValidBlockName(name: string): boolean {
  if (!BLOCK_NAME_PATTERN.test(name)) return false;
  if (RESERVED_BLOCK_NAMES.has(name)) return false;
  return true;
}

export interface AdminChatbotsPluginOpts {
  db: Knex;
}

const adminChatbotsPlugin: FastifyPluginAsync<AdminChatbotsPluginOpts> = async (fastify, opts) => {
  const { db } = opts;

  fastify.addHook('preHandler', makeVerifyAccountAdminBearer(db));

  // Markdown / plain text body parsers for the block PUT endpoint. Default
  // Fastify only parses JSON; PUT /blocks/{name} accepts raw text bodies.
  fastify.addContentTypeParser('text/markdown', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });
  fastify.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  /**
   * Resolve a chatbot by slug AND enforce the cross-account guard. Returns
   * the row when the auth'd account owns it, or sends a coherent 4xx and
   * returns null. The cross-account 403 path deliberately uses the same
   * error code regardless of whether the chatbot exists in some other
   * account or doesn't exist at all — disclosing the difference would leak
   * cross-account information.
   */
  async function resolveChatbotForAccount(
    req: FastifyRequest,
    reply: FastifyReply,
    slug: string,
  ): Promise<Chatbot | null> {
    const accountId = req.adminContext?.accountId;
    if (!accountId) {
      // Middleware should have set this; defence-in-depth.
      reply.status(401).send({ error: 'bearer_invalid' });
      return null;
    }
    const chatbot = await getChatbotBySlug(db, slug);
    if (!chatbot || chatbot.account_id !== accountId) {
      reply.status(404).send({ error: 'not_found' });
      return null;
    }
    return chatbot;
  }

  // -------------------------------------------------------------------------
  // Core CRUD
  // -------------------------------------------------------------------------

  fastify.get(
    '/',
    {
      schema: {
        tags: ['admin'],
        summary: "List the auth'd account's chatbots",
        security: [{ adminBearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: { chatbots: { type: 'array', items: chatbotSchema } },
            required: ['chatbots'],
          },
          401: errorResponseSchema,
        },
      },
    },
    async (req) => {
      const accountId = req.adminContext!.accountId;
      const all = await listChatbots(db);
      return { chatbots: all.filter((c) => c.account_id === accountId) };
    },
  );

  fastify.post<{ Body: { slug?: unknown; name?: unknown; persona?: unknown } }>(
    '/',
    {
      schema: {
        tags: ['admin'],
        summary: "Create a chatbot in the auth'd account",
        description:
          'Body: `{ slug, name, persona? }`. Slug must be 1–64 lowercase alphanumeric+hyphens. ' +
          "Persona defaults to NULL (no template seeding via HTTP; that's a CLI convenience). " +
          '409 if the slug is already taken on this deployment.',
        security: [{ adminBearerAuth: [] }],
        response: {
          201: chatbotSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const accountId = req.adminContext!.accountId;
      const body = req.body;
      if (!body || typeof body.slug !== 'string' || typeof body.name !== 'string') {
        return reply.status(400).send({
          error: 'validation_failed',
          detail: { message: 'Body requires `slug` and `name` strings.' },
        });
      }
      const persona =
        typeof body.persona === 'string' ? body.persona : body.persona === null ? null : undefined;
      try {
        const created = await createChatbot(db, {
          account_id: accountId,
          slug: body.slug,
          name: body.name,
          persona: persona ?? null,
        });
        return reply.status(201).send(created);
      } catch (err) {
        const msg = (err as Error).message;
        if (/Invalid slug/.test(msg)) {
          return reply.status(400).send({ error: 'validation_failed', detail: { message: msg } });
        }
        if (
          /ER_DUP_ENTRY/.test(msg) ||
          /Duplicate entry/.test(msg) ||
          /chatbots_slug_unique/.test(msg)
        ) {
          return reply.status(409).send({
            error: 'conflict',
            detail: { message: `Chatbot with slug "${body.slug}" already exists.` },
          });
        }
        throw err;
      }
    },
  );

  fastify.get<{ Params: { slug: string } }>(
    '/:slug',
    {
      schema: {
        tags: ['admin'],
        summary: 'Get a chatbot',
        security: [{ adminBearerAuth: [] }],
        params: {
          type: 'object',
          properties: { slug: { type: 'string' } },
          required: ['slug'],
        },
        response: {
          200: chatbotSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const chatbot = await resolveChatbotForAccount(req, reply, req.params.slug);
      if (!chatbot) return;
      return reply.send(chatbot);
    },
  );

  type ChatbotPatchBody = {
    name?: unknown;
    welcome_message?: unknown;
    persona?: unknown;
    model_slug?: unknown;
    model_parameters?: unknown;
    model_context_window?: unknown;
    daily_budget_usd?: unknown;
    session_budget_usd?: unknown;
    handoff_threshold_pct?: unknown;
    handoff_webhook_url?: unknown;
  };

  fastify.patch<{ Params: { slug: string }; Body: ChatbotPatchBody }>(
    '/:slug',
    {
      schema: {
        tags: ['admin'],
        summary: 'Patch a chatbot',
        description:
          'Updatable fields: `name`, `welcome_message`, `persona`, `model_slug`, ' +
          '`model_parameters`, `model_context_window`. Each field is optional; ' +
          'fields omitted from the body are left untouched. The `slug`, ' +
          '`account_id`, `provider_api_key_*` and geo settings have their own ' +
          'endpoints (or are immutable here). Validation matches the CLI helpers.',
        security: [{ adminBearerAuth: [] }],
        params: {
          type: 'object',
          properties: { slug: { type: 'string' } },
          required: ['slug'],
        },
        response: {
          200: chatbotSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const chatbot = await resolveChatbotForAccount(req, reply, req.params.slug);
      if (!chatbot) return;
      const body = req.body ?? {};
      const slug = chatbot.slug;
      const sets: Record<string, unknown> = {};

      if (Object.prototype.hasOwnProperty.call(body, 'name')) {
        if (typeof body.name !== 'string' || body.name.length === 0) {
          return reply.status(400).send({
            error: 'validation_failed',
            detail: { message: '`name` must be a non-empty string.' },
          });
        }
        sets.name = body.name;
      }

      if (Object.prototype.hasOwnProperty.call(body, 'welcome_message')) {
        if (body.welcome_message !== null && typeof body.welcome_message !== 'string') {
          return reply.status(400).send({
            error: 'validation_failed',
            detail: { message: '`welcome_message` must be string or null.' },
          });
        }
        // Use the existing helper so empty-string semantics (clears column) match
        // the CLI surface.
        await setWelcomeMessage(db, slug, body.welcome_message ?? '');
      }

      if (Object.prototype.hasOwnProperty.call(body, 'persona')) {
        if (body.persona !== null && typeof body.persona !== 'string') {
          return reply.status(400).send({
            error: 'validation_failed',
            detail: { message: '`persona` must be string or null.' },
          });
        }
        // setPersona doesn't take NULL — for NULL semantics we go direct.
        if (body.persona === null) {
          await db('chatbots').where({ slug }).update({ persona: null });
        } else {
          await setPersona(db, slug, body.persona);
        }
      }

      if (Object.prototype.hasOwnProperty.call(body, 'model_slug')) {
        if (body.model_slug !== null && typeof body.model_slug !== 'string') {
          return reply.status(400).send({
            error: 'validation_failed',
            detail: { message: '`model_slug` must be string or null.' },
          });
        }
        if (body.model_slug === null) {
          await db('chatbots').where({ slug }).update({ model_slug: null });
        } else {
          try {
            await setModel(db, slug, body.model_slug);
          } catch (err) {
            return reply.status(400).send({
              error: 'validation_failed',
              detail: { message: (err as Error).message },
            });
          }
        }
      }

      if (Object.prototype.hasOwnProperty.call(body, 'model_parameters')) {
        try {
          await setParameters(db, slug, body.model_parameters);
        } catch (err) {
          return reply.status(400).send({
            error: 'validation_failed',
            detail: { message: (err as Error).message },
          });
        }
      }

      if (Object.prototype.hasOwnProperty.call(body, 'model_context_window')) {
        if (body.model_context_window === null) {
          await db('chatbots').where({ slug }).update({ model_context_window: null });
        } else if (
          typeof body.model_context_window === 'number' &&
          Number.isInteger(body.model_context_window) &&
          body.model_context_window > 0
        ) {
          await setContextWindow(db, slug, body.model_context_window);
        } else {
          return reply.status(400).send({
            error: 'validation_failed',
            detail: { message: '`model_context_window` must be positive integer or null.' },
          });
        }
      }

      // M20: budget caps + handoff webhook. Sanity-bound via env so a stolen
      // admin key can't set a $1,000,000 cap. NULL clears the column. Numbers
      // accepted as either `number` or `string` (the latter so JSON like
      // "0.50" — the DECIMAL-serialised form — round-trips cleanly).
      const validateCap = (
        raw: unknown,
        field: 'daily_budget_usd' | 'session_budget_usd',
        upper: number,
      ): { ok: true; value: string | null } | { ok: false; message: string } => {
        if (raw === null) return { ok: true, value: null };
        const asNum = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
        if (!Number.isFinite(asNum) || asNum <= 0) {
          return { ok: false, message: `\`${field}\` must be a positive number or null.` };
        }
        if (asNum > upper) {
          return {
            ok: false,
            message: `\`${field}\` ${asNum} exceeds environment cap ${upper} (\`SW_MAX_${field.toUpperCase()}\`).`,
          };
        }
        // Store with 4-dp precision to match the DECIMAL(10,4) column.
        return { ok: true, value: asNum.toFixed(4) };
      };

      if (Object.prototype.hasOwnProperty.call(body, 'daily_budget_usd')) {
        const r = validateCap(body.daily_budget_usd, 'daily_budget_usd', env.maxDailyBudgetUsd);
        if (!r.ok) {
          return reply
            .status(400)
            .send({ error: 'validation_failed', detail: { message: r.message } });
        }
        sets.daily_budget_usd = r.value;
      }

      if (Object.prototype.hasOwnProperty.call(body, 'session_budget_usd')) {
        const r = validateCap(
          body.session_budget_usd,
          'session_budget_usd',
          env.maxSessionBudgetUsd,
        );
        if (!r.ok) {
          return reply
            .status(400)
            .send({ error: 'validation_failed', detail: { message: r.message } });
        }
        sets.session_budget_usd = r.value;
      }

      if (Object.prototype.hasOwnProperty.call(body, 'handoff_threshold_pct')) {
        const pct = body.handoff_threshold_pct;
        if (typeof pct !== 'number' || !Number.isInteger(pct) || pct < 1 || pct > 100) {
          return reply.status(400).send({
            error: 'validation_failed',
            detail: { message: '`handoff_threshold_pct` must be an integer in [1, 100].' },
          });
        }
        sets.handoff_threshold_pct = pct;
      }

      if (Object.prototype.hasOwnProperty.call(body, 'handoff_webhook_url')) {
        if (body.handoff_webhook_url === null) {
          sets.handoff_webhook_url = null;
        } else if (typeof body.handoff_webhook_url === 'string') {
          let url: URL;
          try {
            url = new URL(body.handoff_webhook_url);
          } catch {
            return reply.status(400).send({
              error: 'validation_failed',
              detail: { message: '`handoff_webhook_url` must be a parseable URL or null.' },
            });
          }
          if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return reply.status(400).send({
              error: 'validation_failed',
              detail: { message: '`handoff_webhook_url` scheme must be http or https.' },
            });
          }
          if (body.handoff_webhook_url.length > 255) {
            return reply.status(400).send({
              error: 'validation_failed',
              detail: { message: '`handoff_webhook_url` must be ≤255 chars.' },
            });
          }
          sets.handoff_webhook_url = body.handoff_webhook_url;
        } else {
          return reply.status(400).send({
            error: 'validation_failed',
            detail: { message: '`handoff_webhook_url` must be a string or null.' },
          });
        }
      }

      if (Object.keys(sets).length > 0) {
        await db('chatbots').where({ slug }).update(sets);
      }

      const updated = await getChatbotBySlug(db, slug);
      return reply.send(updated);
    },
  );

  fastify.delete<{ Params: { slug: string } }>(
    '/:slug',
    {
      schema: {
        tags: ['admin'],
        summary: 'Delete a chatbot and cascade through origins/sessions/messages',
        security: [{ adminBearerAuth: [] }],
        params: {
          type: 'object',
          properties: { slug: { type: 'string' } },
          required: ['slug'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              origins: { type: 'integer' },
              sessions: { type: 'integer' },
              messages: { type: 'integer' },
            },
            required: ['origins', 'sessions', 'messages'],
          },
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const chatbot = await resolveChatbotForAccount(req, reply, req.params.slug);
      if (!chatbot) return;
      const counts = await deleteChatbot(db, chatbot.slug);
      return reply.send(counts);
    },
  );

  // -------------------------------------------------------------------------
  // Origins
  // -------------------------------------------------------------------------

  fastify.get<{ Params: { slug: string } }>(
    '/:slug/origins',
    {
      schema: {
        tags: ['admin'],
        summary: "List a chatbot's allowlisted origins",
        security: [{ adminBearerAuth: [] }],
        params: {
          type: 'object',
          properties: { slug: { type: 'string' } },
          required: ['slug'],
        },
        response: {
          200: {
            type: 'object',
            properties: { origins: { type: 'array', items: originRowSchema } },
            required: ['origins'],
          },
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const chatbot = await resolveChatbotForAccount(req, reply, req.params.slug);
      if (!chatbot) return;
      const origins = await listOrigins(db, chatbot.slug);
      return reply.send({ origins });
    },
  );

  fastify.post<{ Params: { slug: string }; Body: { origin?: unknown } }>(
    '/:slug/origins',
    {
      schema: {
        tags: ['admin'],
        summary: "Add an origin to a chatbot's allowlist",
        description:
          'Body: `{ origin }`. Origin is normalised (lowercased host, no trailing slash, ' +
          'distinct scheme between http/https). Globally unique — 409 if another chatbot ' +
          '(or this one) already owns it.',
        security: [{ adminBearerAuth: [] }],
        params: {
          type: 'object',
          properties: { slug: { type: 'string' } },
          required: ['slug'],
        },
        response: {
          201: originRowSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const chatbot = await resolveChatbotForAccount(req, reply, req.params.slug);
      if (!chatbot) return;
      const rawOrigin = req.body?.origin;
      if (typeof rawOrigin !== 'string') {
        return reply.status(400).send({
          error: 'validation_failed',
          detail: { message: 'Body requires an `origin` string.' },
        });
      }
      let normalised: string;
      try {
        normalised = normaliseOrigin(rawOrigin);
      } catch (err) {
        return reply.status(400).send({
          error: 'validation_failed',
          detail: { message: (err as Error).message },
        });
      }
      const existing = await findChatbotByOrigin(db, normalised);
      if (existing) {
        return reply.status(409).send({
          error: 'conflict',
          detail: { message: `Origin "${normalised}" is already registered.` },
        });
      }
      const row = await addOrigin(db, chatbot.slug, rawOrigin);
      return reply.status(201).send(row);
    },
  );

  fastify.delete<{ Params: { slug: string; originId: string } }>(
    '/:slug/origins/:originId',
    {
      schema: {
        tags: ['admin'],
        summary: 'Remove an origin from the allowlist',
        security: [{ adminBearerAuth: [] }],
        params: {
          type: 'object',
          properties: {
            slug: { type: 'string' },
            originId: { type: 'string' },
          },
          required: ['slug', 'originId'],
        },
        response: {
          204: { type: 'null' },
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const chatbot = await resolveChatbotForAccount(req, reply, req.params.slug);
      if (!chatbot) return;
      if (!/^\d+$/.test(req.params.originId)) {
        return reply.status(404).send({ error: 'not_found' });
      }
      try {
        await removeOrigin(db, chatbot.slug, req.params.originId);
      } catch (err) {
        if (/Origin not found/.test((err as Error).message)) {
          return reply.status(404).send({ error: 'not_found' });
        }
        throw err;
      }
      return reply.status(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // Blocks (filesystem-backed; mirror loadDiskBlocks' conventions)
  // -------------------------------------------------------------------------

  function chatbotBlocksDir(slug: string): string {
    return path.join(DEFAULT_DATA_DIR, slug);
  }

  function blockFilePath(slug: string, name: string): string {
    return path.join(chatbotBlocksDir(slug), `${name}.md`);
  }

  fastify.get<{ Params: { slug: string } }>(
    '/:slug/blocks',
    {
      schema: {
        tags: ['admin'],
        summary: "List a chatbot's disk-resident system blocks",
        description:
          'Returns block names + byte sizes. PERSONA is a DB column, not a block, ' +
          'so it does not appear here — read/write persona via the chatbot PATCH endpoint.',
        security: [{ adminBearerAuth: [] }],
        params: {
          type: 'object',
          properties: { slug: { type: 'string' } },
          required: ['slug'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              blocks: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    size_bytes: { type: 'integer' },
                  },
                  required: ['name', 'size_bytes'],
                },
              },
            },
            required: ['blocks'],
          },
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const chatbot = await resolveChatbotForAccount(req, reply, req.params.slug);
      if (!chatbot) return;
      const dir = chatbotBlocksDir(chatbot.slug);
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reply.send({ blocks: [] });
        }
        throw err;
      }
      const blocks: Array<{ name: string; size_bytes: number }> = [];
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (path.extname(entry.name).toLowerCase() !== '.md') continue;
        const name = path.basename(entry.name, '.md');
        if (RESERVED_BLOCK_NAMES.has(name)) continue;
        const stats = await stat(path.join(dir, entry.name));
        blocks.push({ name, size_bytes: stats.size });
      }
      blocks.sort((a, b) => a.name.localeCompare(b.name));
      return reply.send({ blocks });
    },
  );

  fastify.get<{ Params: { slug: string; name: string } }>(
    '/:slug/blocks/:name',
    {
      schema: {
        tags: ['admin'],
        summary: 'Fetch a single block by name',
        description: 'Returns the raw markdown body as text/markdown.',
        security: [{ adminBearerAuth: [] }],
        params: {
          type: 'object',
          properties: {
            slug: { type: 'string' },
            name: { type: 'string' },
          },
          required: ['slug', 'name'],
        },
        response: {
          200: { type: 'string' },
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const chatbot = await resolveChatbotForAccount(req, reply, req.params.slug);
      if (!chatbot) return;
      if (!isValidBlockName(req.params.name)) {
        return reply.status(404).send({ error: 'not_found' });
      }
      try {
        const content = await readFile(blockFilePath(chatbot.slug, req.params.name), 'utf8');
        return reply.header('content-type', 'text/markdown; charset=utf-8').send(content);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reply.status(404).send({ error: 'not_found' });
        }
        throw err;
      }
    },
  );

  fastify.put<{ Params: { slug: string; name: string }; Body: string | unknown }>(
    '/:slug/blocks/:name',
    {
      schema: {
        tags: ['admin'],
        summary: 'Write a block (overwrite if exists)',
        description:
          'Body content-type must be `text/markdown` or `text/plain`. Body is the raw ' +
          'block content. Max 64KB. Block name validator: `^[A-Za-z0-9_-]+$`, PERSONA ' +
          'reserved. Creates the chatbot data directory if absent.',
        security: [{ adminBearerAuth: [] }],
        consumes: ['text/markdown', 'text/plain'],
        params: {
          type: 'object',
          properties: {
            slug: { type: 'string' },
            name: { type: 'string' },
          },
          required: ['slug', 'name'],
        },
        response: {
          204: { type: 'null' },
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          413: errorResponseSchema,
          415: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const chatbot = await resolveChatbotForAccount(req, reply, req.params.slug);
      if (!chatbot) return;
      if (!isValidBlockName(req.params.name)) {
        return reply.status(400).send({
          error: 'validation_failed',
          detail: { message: 'Block name must match ^[A-Za-z0-9_-]+$ and not be PERSONA.' },
        });
      }
      const ct = req.headers['content-type'];
      if (
        typeof ct !== 'string' ||
        !(ct.startsWith('text/markdown') || ct.startsWith('text/plain'))
      ) {
        return reply.status(415).send({
          error: 'validation_failed',
          detail: { message: 'Content-Type must be text/markdown or text/plain.' },
        });
      }
      const body = req.body;
      if (typeof body !== 'string') {
        return reply.status(400).send({
          error: 'validation_failed',
          detail: { message: 'Body must be the raw block content (utf-8 text).' },
        });
      }
      const byteLength = Buffer.byteLength(body, 'utf8');
      if (byteLength > MAX_BLOCK_BYTES) {
        return reply.status(413).send({
          error: 'validation_failed',
          detail: {
            message: `Block content is ${byteLength} bytes; cap is ${MAX_BLOCK_BYTES}.`,
          },
        });
      }
      const dir = chatbotBlocksDir(chatbot.slug);
      await mkdir(dir, { recursive: true });
      await writeFile(blockFilePath(chatbot.slug, req.params.name), body, 'utf8');
      return reply.status(204).send();
    },
  );

  fastify.delete<{ Params: { slug: string; name: string } }>(
    '/:slug/blocks/:name',
    {
      schema: {
        tags: ['admin'],
        summary: 'Delete a block',
        security: [{ adminBearerAuth: [] }],
        params: {
          type: 'object',
          properties: {
            slug: { type: 'string' },
            name: { type: 'string' },
          },
          required: ['slug', 'name'],
        },
        response: {
          204: { type: 'null' },
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const chatbot = await resolveChatbotForAccount(req, reply, req.params.slug);
      if (!chatbot) return;
      if (!isValidBlockName(req.params.name)) {
        return reply.status(404).send({ error: 'not_found' });
      }
      try {
        await unlink(blockFilePath(chatbot.slug, req.params.name));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reply.status(404).send({ error: 'not_found' });
        }
        throw err;
      }
      return reply.status(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // api-key (PATCH to set, DELETE to clear)
  // -------------------------------------------------------------------------

  fastify.patch<{ Params: { slug: string }; Body: { api_key?: unknown } }>(
    '/:slug/api-key',
    {
      schema: {
        tags: ['admin'],
        summary: "Set the chatbot's BYO LLM provider API key",
        description:
          'Body: `{ api_key }`. Encrypted on receive via AES-256-GCM; ' +
          'plaintext never persisted, never logged. ≤255 bytes plaintext.',
        security: [{ adminBearerAuth: [] }],
        params: {
          type: 'object',
          properties: { slug: { type: 'string' } },
          required: ['slug'],
        },
        response: {
          204: { type: 'null' },
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const chatbot = await resolveChatbotForAccount(req, reply, req.params.slug);
      if (!chatbot) return;
      const apiKey = req.body?.api_key;
      if (typeof apiKey !== 'string' || apiKey.length === 0) {
        return reply.status(400).send({
          error: 'validation_failed',
          detail: { message: 'Body requires a non-empty `api_key` string.' },
        });
      }
      if (Buffer.byteLength(apiKey, 'utf8') > 255) {
        return reply.status(400).send({
          error: 'validation_failed',
          detail: { message: 'api_key plaintext must be ≤255 bytes.' },
        });
      }
      const masterKey = loadEncryptionKey();
      const secret = encrypt(apiKey, masterKey);
      await db('chatbots').where({ id: chatbot.id }).update({
        provider_api_key_ciphertext: secret.ciphertext,
        provider_api_key_nonce: secret.nonce,
        provider_api_key_auth_tag: secret.authTag,
      });
      return reply.status(204).send();
    },
  );

  fastify.delete<{ Params: { slug: string } }>(
    '/:slug/api-key',
    {
      schema: {
        tags: ['admin'],
        summary: "Clear the chatbot's BYO API key (sets columns to NULL)",
        description:
          'Idempotent. After this, metered-provider chats from this chatbot fail loud ' +
          'with `503 chatbot_api_key_missing` until a new key is set.',
        security: [{ adminBearerAuth: [] }],
        params: {
          type: 'object',
          properties: { slug: { type: 'string' } },
          required: ['slug'],
        },
        response: {
          204: { type: 'null' },
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const chatbot = await resolveChatbotForAccount(req, reply, req.params.slug);
      if (!chatbot) return;
      await db('chatbots').where({ id: chatbot.id }).update({
        provider_api_key_ciphertext: null,
        provider_api_key_nonce: null,
        provider_api_key_auth_tag: null,
      });
      return reply.status(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // usage
  // -------------------------------------------------------------------------

  fastify.get<{ Params: { slug: string }; Querystring: { since?: string } }>(
    '/:slug/usage',
    {
      schema: {
        tags: ['admin'],
        summary: 'Aggregate token + USD usage for a chatbot',
        description:
          'Same shape as the `sw chatbot usage` CLI. `since` is a relative duration ' +
          'like `24h`, `7d`, `30d`, `5m`, `90s`. Omitted = all-time.',
        security: [{ adminBearerAuth: [] }],
        params: {
          type: 'object',
          properties: { slug: { type: 'string' } },
          required: ['slug'],
        },
        querystring: {
          type: 'object',
          properties: { since: { type: 'string' } },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              message_count: { type: 'integer' },
              tokens_in: { type: 'integer' },
              tokens_out: { type: 'integer' },
              cost_usd: { type: 'number' },
              cache_creation_tokens: { type: 'integer' },
              cache_read_tokens: { type: 'integer' },
              period: {
                type: 'object',
                properties: {
                  since: { type: ['string', 'null'], format: 'date-time' },
                  until: { type: 'string', format: 'date-time' },
                },
                required: ['since', 'until'],
              },
              warnings: { type: 'array', items: { type: 'string' } },
            },
            required: [
              'message_count',
              'tokens_in',
              'tokens_out',
              'cost_usd',
              'cache_creation_tokens',
              'cache_read_tokens',
              'period',
              'warnings',
            ],
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const chatbot = await resolveChatbotForAccount(req, reply, req.params.slug);
      if (!chatbot) return;
      const until = new Date();
      let since: Date | undefined;
      if (req.query?.since) {
        try {
          since = parseSinceDuration(req.query.since, until);
        } catch (err) {
          return reply.status(400).send({
            error: 'validation_failed',
            detail: { message: (err as Error).message },
          });
        }
      }
      const usage = await getChatbotUsage(db, chatbot.id, since);

      const warnings: string[] = [];
      if (chatbot.model_slug) {
        try {
          const resolved = await resolveModel(db, chatbot);
          if (
            resolved.provider.is_metered &&
            (resolved.providerModel.input_per_million_usd === null ||
              resolved.providerModel.output_per_million_usd === null)
          ) {
            warnings.push(
              `Cost may be under-counted: chatbot's current model row "${resolved.modelSlug}" ` +
                `has NULL pricing on metered provider "${resolved.provider.name}".`,
            );
          }
        } catch {
          // resolveModel can throw if the provider/model row was deleted out
          // from under the chatbot. Surface as a warning rather than 500.
          warnings.push(
            `Chatbot's current model_slug "${chatbot.model_slug}" does not resolve. ` +
              `New chats will fail until model_slug is reset.`,
          );
        }
      }

      return reply.send({
        message_count: usage.messageCount,
        tokens_in: usage.tokensIn,
        tokens_out: usage.tokensOut,
        cost_usd: usage.costUsd,
        cache_creation_tokens: usage.cacheCreationTokens,
        cache_read_tokens: usage.cacheReadTokens,
        period: {
          since: since ? since.toISOString() : null,
          until: until.toISOString(),
        },
        warnings,
      });
    },
  );

  // -------------------------------------------------------------------------
  // geo (GET + PATCH)
  // -------------------------------------------------------------------------

  fastify.get<{ Params: { slug: string } }>(
    '/:slug/geo',
    {
      schema: {
        tags: ['admin'],
        summary: "Get a chatbot's geo policy (mode + country list)",
        security: [{ adminBearerAuth: [] }],
        params: {
          type: 'object',
          properties: { slug: { type: 'string' } },
          required: ['slug'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: ['allowall', 'blocklist', 'allowlist'] },
              countries: { type: 'array', items: { type: 'string' } },
            },
            required: ['mode', 'countries'],
          },
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const chatbot = await resolveChatbotForAccount(req, reply, req.params.slug);
      if (!chatbot) return;
      const summary = await getChatbotGeoSummary(db, chatbot.slug);
      return reply.send({ mode: summary.modeCode, countries: summary.countries });
    },
  );

  fastify.patch<{
    Params: { slug: string };
    Body: { mode?: unknown; countries?: unknown };
  }>(
    '/:slug/geo',
    {
      schema: {
        tags: ['admin'],
        summary: "Update a chatbot's geo policy",
        description:
          'Body: `{ mode?, countries? }`. `mode` is one of allowall/blocklist/allowlist. ' +
          '`countries` is an array of ISO 3166-1 alpha-2 codes; pass `[]` to clear. ' +
          'Either field is optional; passing neither is a no-op (still returns the current policy).',
        security: [{ adminBearerAuth: [] }],
        params: {
          type: 'object',
          properties: { slug: { type: 'string' } },
          required: ['slug'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: ['allowall', 'blocklist', 'allowlist'] },
              countries: { type: 'array', items: { type: 'string' } },
            },
            required: ['mode', 'countries'],
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const chatbot = await resolveChatbotForAccount(req, reply, req.params.slug);
      if (!chatbot) return;
      const body = req.body ?? {};
      if (Object.prototype.hasOwnProperty.call(body, 'mode')) {
        if (typeof body.mode !== 'string') {
          return reply.status(400).send({
            error: 'validation_failed',
            detail: { message: '`mode` must be a string.' },
          });
        }
        try {
          await setChatbotGeoMode(db, chatbot.slug, body.mode);
        } catch (err) {
          return reply.status(400).send({
            error: 'validation_failed',
            detail: { message: (err as Error).message },
          });
        }
      }
      if (Object.prototype.hasOwnProperty.call(body, 'countries')) {
        if (
          !Array.isArray(body.countries) ||
          !body.countries.every((c): c is string => typeof c === 'string')
        ) {
          return reply.status(400).send({
            error: 'validation_failed',
            detail: { message: '`countries` must be an array of strings.' },
          });
        }
        try {
          await setChatbotGeoCountries(db, chatbot.slug, body.countries);
        } catch (err) {
          return reply.status(400).send({
            error: 'validation_failed',
            detail: { message: (err as Error).message },
          });
        }
      }
      const summary = await getChatbotGeoSummary(db, chatbot.slug);
      return reply.send({ mode: summary.modeCode, countries: summary.countries });
    },
  );
};

export default adminChatbotsPlugin;
