import Fastify, { type FastifyInstance } from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import type { Knex } from 'knex';
import { findChatbotByOrigin } from './services/chatbots.js';
import { createSession, findSessionByToken, listMessages } from './services/sessions.js';
import { ChatError, resolveSimValue, runChat, type AdapterFactory } from './services/chat.js';
import {
  getChatbotDailySpend,
  isDailyBudgetExhausted,
  parseCapDecimal,
} from './services/budget.js';
import { isOpenNow } from './services/availability.js';
import adminAccountsPlugin from './routes/admin-accounts.js';
import adminChatbotsPlugin from './routes/admin-chatbots.js';
import { notifyHandoff } from './services/handoff-webhook.js';
import {
  checkGeoPolicy,
  loadChatbotGeoPolicy,
  type CheckGeoResult,
  type GeoChecker,
} from './services/geo.js';
import { env as runtimeEnv } from './config/env.js';
import { extractBearerToken } from './utils/bearer.js';
import { ChatbotRateLimiter, type RateLimitDecision } from './services/rate-limit.js';
import { VERSION } from './utils/version.js';

const DEFAULT_WELCOME = 'Hi! How can I help?';
const STRAPLINE = 'A self-hosted, multi-tenant pre-sales chatbot API.';
const GITHUB_URL = 'https://github.com/headwalluk/site-walker';

export interface BuildServerOpts {
  db: Knex;
  logger?: boolean;
  /** Replace the adapter factory used by /chat (tests inject a fake). */
  adapterFactory?: AdapterFactory;
  /**
   * Country lookup for geo-blocking. Pass `null` to skip lookups entirely
   * (only safe when every chatbot is in `allowall` mode — production code
   * checks for this at boot). Tests inject a stub.
   */
  geoChecker?: GeoChecker | null;
  /**
   * M23 rate-limit overrides. Default reads from runtime env. When
   * `disabled: true`, no per-IP or per-chatbot limiting applies. Tests pass
   * small caps + an injected clock so the 429 path is reachable without
   * 11+ requests.
   */
  rateLimit?: {
    disabled?: boolean;
    sessionsPerIp?: number;
    chatPerIp?: number;
    sessionsPerChatbot?: number;
    chatPerChatbot?: number;
    /** Clock for the per-chatbot limiter's window math (tests-only). */
    now?: () => number;
  };
  /**
   * M23.5 simulation hooks. Tests pass per-server overrides here; production
   * code leaves this unset and runChat falls back to `runtimeEnv.sim` for
   * each request. Per-field semantics match `RunChatInput.sim`:
   * undefined → env, null → explicit force-off, number → that threshold.
   */
  sim?: {
    softHandoffAfterUserTurns?: number | null;
    hardHandoffAfterUserTurns?: number | null;
  };
}

const CHAT_ERROR_STATUS = {
  invalid_token: 401,
  message_required: 400,
  message_too_long: 400,
  context_overflow: 413,
  model_not_configured: 503,
  chatbot_api_key_missing: 503,
  model_error: 502,
} as const satisfies Record<ChatError['code'], number>;

/**
 * Build the 429 response shape for both the per-IP plugin path and the
 * per-chatbot manual path. Same `error` code, same `detail` shape, so
 * widget developers see one vocabulary regardless of which layer refused.
 */
function rateLimitResponseBody(retryAfterSeconds: number): {
  error: 'rate_limit_exceeded';
  detail: { retry_after_seconds: number };
} {
  return {
    error: 'rate_limit_exceeded',
    detail: { retry_after_seconds: retryAfterSeconds },
  };
}

function clientPrefersHtml(acceptHeader: string | undefined): boolean {
  if (!acceptHeader) return false;
  return acceptHeader.toLowerCase().includes('text/html');
}

function renderLandingPage(version: string, year: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>site-walker</title>
<style>
:root {
  --bg-from: #1a2540;
  --bg-to: #0f1830;
  --card: #243a6b;
  --text: #e6ecf8;
  --muted: #9eb0d4;
  --border: rgba(255,255,255,0.08);
  --button-bg: rgba(255,255,255,0.04);
  --button-bg-hover: rgba(255,255,255,0.10);
  --pill-good-bg: #2f8d4a;
  --pill-good-fg: #d8f7e0;
  --pill-bad-bg: #b94545;
  --pill-bad-fg: #ffd5d5;
  --pill-unknown-bg: #4a5568;
  --pill-unknown-fg: #cbd5e0;
}
html, body { height: 100%; margin: 0; }
body {
  background: linear-gradient(160deg, var(--bg-from), var(--bg-to));
  color: var(--text);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, sans-serif;
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
}
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 40px 40px 32px;
  width: 100%; max-width: 480px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.35);
  text-align: center;
}
h1 { margin: 0 0 6px; font-size: 28px; font-weight: 600; letter-spacing: -0.01em; }
.version { color: var(--muted); font-size: 13px; margin-bottom: 20px; }
.strapline { color: var(--muted); font-size: 14px; line-height: 1.5; margin-bottom: 24px; }
.pill {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 10px 18px;
  border-radius: 999px;
  font-size: 13px; font-weight: 500;
  margin-bottom: 24px;
}
.pill .dot { width: 8px; height: 8px; border-radius: 50%; }
.pill.unknown { background: var(--pill-unknown-bg); color: var(--pill-unknown-fg); }
.pill.unknown .dot { background: var(--pill-unknown-fg); animation: pulse 1.2s ease-in-out infinite; }
.pill.good { background: var(--pill-good-bg); color: var(--pill-good-fg); }
.pill.good .dot { background: var(--pill-good-fg); }
.pill.bad { background: var(--pill-bad-bg); color: var(--pill-bad-fg); }
.pill.bad .dot { background: var(--pill-bad-fg); }
@keyframes pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }
.links {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
a.button {
  display: block;
  padding: 12px 14px;
  background: var(--button-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  text-decoration: none;
  font-size: 13px;
  transition: background 120ms;
}
a.button:hover, a.button:focus { background: var(--button-bg-hover); outline: none; }
footer { color: var(--muted); font-size: 11px; margin-top: 28px; }
footer a { color: var(--muted); }
</style>
</head>
<body>
  <main class="card">
    <h1>site-walker</h1>
    <div class="version">Version ${version}</div>
    <div class="strapline">${STRAPLINE}</div>
    <div id="status" class="pill unknown" role="status" aria-live="polite">
      <span class="dot"></span>
      <span class="label">Checking…</span>
    </div>
    <nav class="links">
      <a class="button" href="/health">Health Check</a>
      <a class="button" href="${GITHUB_URL}">GitHub Repo</a>
      <a class="button" href="/docs">API Documentation</a>
      <a class="button" href="/openapi.json">OpenAPI JSON</a>
    </nav>
    <footer>
      &copy; ${year} Headwall Hosting &middot;
      <a href="${GITHUB_URL}/blob/main/LICENSE">AGPL-3.0</a>
    </footer>
  </main>
  <script>
  (async () => {
    const pill = document.getElementById('status');
    const label = pill.querySelector('.label');
    try {
      const res = await fetch('/health', { headers: { 'Accept': 'application/json' } });
      const data = await res.json();
      pill.classList.remove('unknown');
      if (data && data.ok) {
        pill.classList.add('good');
        label.textContent = 'System Operational';
      } else {
        pill.classList.add('bad');
        label.textContent = 'Degraded';
      }
    } catch (e) {
      pill.classList.remove('unknown');
      pill.classList.add('bad');
      label.textContent = 'Unreachable';
    }
  })();
  </script>
</body>
</html>
`;
}

const errorResponseSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    detail: { type: 'object', additionalProperties: true },
  },
  required: ['error'],
};

async function enforceGeo(
  db: Knex,
  chatbotId: number,
  ip: string,
  checker: GeoChecker | null,
): Promise<CheckGeoResult> {
  const policy = await loadChatbotGeoPolicy(db, chatbotId);
  return checkGeoPolicy(policy, ip, checker, { isProduction: runtimeEnv.isProduction });
}

export async function buildServer(opts: BuildServerOpts): Promise<FastifyInstance> {
  const { db, logger = true, adapterFactory } = opts;
  const geoChecker: GeoChecker | null = opts.geoChecker ?? null;
  // trustProxy: required for X-Forwarded-For to be honoured behind nginx /
  // Cloudflare / whatever fronts api.site-walker.net. In dev with no proxy
  // it's a no-op — req.ip falls through to the socket address.
  const fastify = Fastify({ logger, trustProxy: true });

  // M23 rate-limit setup. Opts override env so tests can dial caps down
  // without touching process.env (env module is loaded once at import).
  const rlOverride = opts.rateLimit;
  const rlEnabled = rlOverride?.disabled === true ? false : runtimeEnv.rateLimit.enabled;
  const sessionsPerIp = rlOverride?.sessionsPerIp ?? runtimeEnv.rateLimit.sessionsPerIp;
  const chatPerIp = rlOverride?.chatPerIp ?? runtimeEnv.rateLimit.chatPerIp;
  const sessionsPerChatbot =
    rlOverride?.sessionsPerChatbot ?? runtimeEnv.rateLimit.sessionsPerChatbot;
  const chatPerChatbot = rlOverride?.chatPerChatbot ?? runtimeEnv.rateLimit.chatPerChatbot;
  const chatbotRateLimiter = new ChatbotRateLimiter(
    { sessions: sessionsPerChatbot, chat: chatPerChatbot },
    rlOverride?.now,
  );

  if (rlEnabled) {
    await fastify.register(fastifyRateLimit, {
      // Per-route opt-in only. Routes that don't carry `config.rateLimit`
      // (e.g. /admin/*, /messages, /sessions/visitor-email) are exempt by
      // construction — no `skip` list to keep in sync.
      global: false,
      // The plugin treats the builder's return value as a thrown error.
      // Fastify reads `statusCode` off it; without that field it defaults
      // to 500. Including `statusCode: 429` keeps the response code right.
      errorResponseBuilder: (_req, context) => ({
        statusCode: 429,
        ...rateLimitResponseBody(Math.ceil(context.ttl / 1000)),
      }),
    });
  }

  function applyChatbotRateLimit(
    chatbotId: number,
    scope: 'sessions' | 'chat',
    reply: import('fastify').FastifyReply,
  ): RateLimitDecision | null {
    if (!rlEnabled) return null;
    const decision = chatbotRateLimiter.check(chatbotId, scope);
    if (!decision.allowed) {
      reply.header('retry-after', String(decision.retryAfterSeconds));
      void reply.status(429).send(rateLimitResponseBody(decision.retryAfterSeconds));
      return decision;
    }
    return decision;
  }

  await fastify.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'site-walker',
        description:
          'Self-hosted multi-tenant pre-sales chatbot API. ' +
          'Browser traffic authenticates by `Origin` allowlist + opaque session token; ' +
          'admin work goes through `./bin/sw` against the local database. ' +
          'See https://github.com/headwalluk/site-walker for full documentation.',
        version: VERSION,
        license: { name: 'AGPL-3.0-only', url: `${GITHUB_URL}/blob/main/LICENSE` },
      },
      servers: [{ url: '/', description: 'this instance' }],
      tags: [
        { name: 'meta', description: 'service metadata and health' },
        { name: 'sessions', description: 'session lifecycle (browser auth)' },
        { name: 'messages', description: 'conversation rehydrate' },
        { name: 'chat', description: 'send a turn, get a reply' },
        { name: 'admin', description: 'operator + provisioning HTTP surface (M19)' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'session-token (64 hex chars from POST /sessions)',
            description:
              'Session token returned by `POST /sessions`. Carry it as ' +
              '`Authorization: Bearer <session_token>` on `GET /messages` and `POST /chat`.',
          },
          adminBearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'admin key (sw_<base64url-32>)',
            description:
              'Admin bearer for the `/admin/*` surface. Either the deployment ' +
              '`SW_PROVISIONING_KEY` (gates `/admin/accounts/*`) or an account ' +
              'admin key minted via `sw account add-admin-key` or ' +
              '`POST /admin/accounts/{accountId}/keys` (gates `/admin/chatbots/*`). ' +
              'Both formats are `sw_<base64url-32>`.',
          },
        },
      },
    },
  });

  await fastify.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: false },
    staticCSP: true,
  });

  // CORS reuses the per-chatbot origin allowlist as its single source of
  // truth: any Origin registered against any chatbot via `sw chatbot origins
  // add` is an allowed CORS origin. Unregistered origins get no CORS header
  // and the browser blocks the response. Non-browser callers (curl, ./bin/chat,
  // server-to-server) send no Origin header and bypass this layer entirely.
  await fastify.register(fastifyCors, {
    origin: async (origin: string | undefined) => {
      if (!origin) return false;
      try {
        const chatbot = await findChatbotByOrigin(db, origin);
        return chatbot !== null;
      } catch {
        return false;
      }
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
    maxAge: 600,
  });

  fastify.get('/openapi.json', { schema: { hide: true } }, async () => fastify.swagger());

  fastify.get(
    '/',
    {
      schema: {
        tags: ['meta'],
        summary: 'Landing page / service metadata',
        description:
          'Responds with an HTML status card when `Accept: text/html` is requested ' +
          '(browsers), otherwise returns the service metadata JSON.',
        response: {
          200: {
            description: 'service metadata (when client does not request HTML)',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              service: { type: 'string' },
              version: { type: 'string' },
            },
            required: ['ok', 'service', 'version'],
          },
        },
      },
    },
    async (req, reply) => {
      if (clientPrefersHtml(req.headers.accept)) {
        return reply
          .header('content-type', 'text/html; charset=utf-8')
          .send(renderLandingPage(VERSION, new Date().getFullYear()));
      }
      return {
        ok: true,
        service: 'site-walker',
        version: VERSION,
      };
    },
  );

  const healthResponseSchema = {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      db: { type: 'boolean' },
      version: { type: 'string' },
      timestamp: { type: 'string', format: 'date-time' },
      // M23.5: only ever present in non-production, and only when at least
      // one SW_SIM_* var is set. Absent entirely in production (which is
      // additionally enforced by the env loader: production refuses to start
      // when any SW_SIM_* var is set).
      sim_active: { type: 'boolean' },
    },
    required: ['ok', 'db', 'version', 'timestamp'],
  };

  fastify.get(
    '/health',
    {
      schema: {
        tags: ['meta'],
        summary: 'Health check',
        description:
          'Returns 200 with `ok: true` when the database is reachable; ' +
          '503 with `ok: false` otherwise. Used by the landing-page status pill.',
        response: { 200: healthResponseSchema, 503: healthResponseSchema },
      },
    },
    async (req, reply) => {
      let dbOk = false;
      try {
        await db.raw('SELECT 1');
        dbOk = true;
      } catch (err) {
        req.log.error({ err }, 'health: DB ping failed');
      }
      const body: {
        ok: boolean;
        db: boolean;
        version: string;
        timestamp: string;
        sim_active?: boolean;
      } = {
        ok: dbOk,
        db: dbOk,
        version: VERSION,
        timestamp: new Date().toISOString(),
      };
      // M23.5: include `sim_active` ONLY in non-production. Production
      // refuses to start when any SW_SIM_* var is set (loadEnv guard), so
      // surfacing the field there would always be a misleading `false`.
      // Uses the same resolveSimValue contract chat.ts uses, so an explicit
      // `null` in opts.sim (test "force off" sentinel) resolves to "not
      // active" even when env has a value set.
      if (!runtimeEnv.isProduction) {
        const effSoft = resolveSimValue(
          opts.sim?.softHandoffAfterUserTurns,
          runtimeEnv.sim.softHandoffAfterUserTurns,
        );
        const effHard = resolveSimValue(
          opts.sim?.hardHandoffAfterUserTurns,
          runtimeEnv.sim.hardHandoffAfterUserTurns,
        );
        body.sim_active = effSoft !== null || effHard !== null;
      }
      return reply.status(dbOk ? 200 : 503).send(body);
    },
  );

  fastify.post(
    '/sessions',
    {
      attachValidation: true,
      config: rlEnabled
        ? {
            rateLimit: { max: sessionsPerIp, timeWindow: '1 minute' },
          }
        : {},
      schema: {
        tags: ['sessions'],
        summary: 'Mint a session token',
        description:
          "Verifies the request `Origin` header against the calling chatbot's " +
          "allowlist and returns an opaque session token plus the chatbot's " +
          'welcome message. The token is carried as `Authorization: Bearer ...` ' +
          'on subsequent calls.',
        headers: {
          type: 'object',
          required: ['origin'],
          properties: {
            origin: {
              type: 'string',
              description:
                "The browser's `Origin` header (scheme + host, no path). " +
                "Must be on the calling chatbot's allowlist.",
              examples: ['https://www.acme-corp.example'],
            },
          },
          additionalProperties: true,
        },
        response: {
          201: {
            description: 'session created',
            type: 'object',
            properties: {
              session_token: { type: 'string' },
              welcome_message: { type: 'string' },
            },
            required: ['session_token', 'welcome_message'],
          },
          400: errorResponseSchema,
          402: errorResponseSchema,
          403: errorResponseSchema,
          429: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const origin = req.headers.origin;
      if (!origin) {
        return reply.status(400).send({ error: 'origin_required' });
      }

      let chatbot = null;
      try {
        chatbot = await findChatbotByOrigin(db, origin);
      } catch {
        // Malformed origin — treat as not allowed.
      }
      if (!chatbot) {
        return reply.status(403).send({ error: 'origin_not_allowed' });
      }

      const geo = await enforceGeo(db, chatbot.id, req.ip, geoChecker);
      if (!geo.allowed) {
        req.log.info(
          {
            ip: req.ip,
            country: geo.country,
            slug: chatbot.slug,
            mode: geo.mode,
            reason: geo.reason,
          },
          'POST /sessions: geo_blocked',
        );
        return reply.status(403).send({ error: 'geo_blocked' });
      }

      // M23 per-chatbot rate limit. Per-IP cap is enforced by the
      // @fastify/rate-limit plugin via `config.rateLimit` above.
      const rlDecision = applyChatbotRateLimit(chatbot.id, 'sessions', reply);
      if (rlDecision && !rlDecision.allowed) return;

      // M20: refuse new sessions when the daily cap is already spent.
      const dailyCap = parseCapDecimal(chatbot.daily_budget_usd);
      if (dailyCap !== null) {
        const dailySpend = await getChatbotDailySpend(db, chatbot.id);
        if (isDailyBudgetExhausted(dailySpend, dailyCap)) {
          return reply.status(402).send({
            error: 'budget_exhausted_daily',
            detail: { cap_usd: dailyCap, spend_usd: dailySpend },
          });
        }
      }

      // M21: refuse new sessions outside the chatbot's operational hours.
      const availability = isOpenNow(chatbot, new Date());
      if (!availability.open) {
        const nextOpenAt = availability.nextOpenAt;
        if (nextOpenAt) {
          const seconds = Math.max(1, Math.ceil((nextOpenAt.getTime() - Date.now()) / 1000));
          reply.header('retry-after', String(Math.min(seconds, 3600)));
        }
        return reply.status(503).send({
          error: 'chatbot_closed',
          detail: { next_open_at: nextOpenAt?.toISOString() ?? null },
        });
      }

      const session = await createSession(db, chatbot.id);
      return reply.status(201).send({
        session_token: session.token,
        welcome_message: chatbot.welcome_message ?? DEFAULT_WELCOME,
      });
    },
  );

  fastify.get(
    '/sessions/can-start',
    {
      attachValidation: true,
      schema: {
        tags: ['sessions'],
        summary: 'Probe whether a session could be minted',
        description:
          'Same auth and geo policy as POST /sessions, but mints nothing. Returns ' +
          '`{ ok: true }` if a session *could* be started by this Origin from this IP. ' +
          'Useful for widgets that want to hide the chat affordance up-front rather ' +
          'than discovering blockers when the visitor tries to type.',
        headers: {
          type: 'object',
          required: ['origin'],
          properties: {
            origin: { type: 'string' },
          },
          additionalProperties: true,
        },
        response: {
          200: {
            description: 'session could be minted',
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
          },
          400: errorResponseSchema,
          402: errorResponseSchema,
          403: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const origin = req.headers.origin;
      if (!origin) {
        return reply.status(400).send({ error: 'origin_required' });
      }

      let chatbot = null;
      try {
        chatbot = await findChatbotByOrigin(db, origin);
      } catch {
        // Malformed origin — treat as not allowed.
      }
      if (!chatbot) {
        return reply.status(403).send({ error: 'origin_not_allowed' });
      }

      const geo = await enforceGeo(db, chatbot.id, req.ip, geoChecker);
      if (!geo.allowed) {
        req.log.info(
          {
            ip: req.ip,
            country: geo.country,
            slug: chatbot.slug,
            mode: geo.mode,
            reason: geo.reason,
          },
          'GET /sessions/can-start: geo_blocked',
        );
        return reply.status(403).send({ error: 'geo_blocked' });
      }

      // M23: no rate limit on this route. It's an idempotent probe used
      // by widgets to decide whether to render the chat affordance. The
      // expensive cousin (`POST /sessions`) carries the per-IP +
      // per-chatbot caps.

      // M20: refuse session-start probes when the daily cap is spent. Mirrors
      // POST /sessions so widgets can hide the chat affordance proactively.
      const dailyCap = parseCapDecimal(chatbot.daily_budget_usd);
      if (dailyCap !== null) {
        const dailySpend = await getChatbotDailySpend(db, chatbot.id);
        if (isDailyBudgetExhausted(dailySpend, dailyCap)) {
          return reply.status(402).send({
            error: 'budget_exhausted_daily',
            detail: { cap_usd: dailyCap, spend_usd: dailySpend },
          });
        }
      }

      // M21: same availability gate as POST /sessions, so the probe reflects
      // closing hours before a widget even tries to mint.
      const availability = isOpenNow(chatbot, new Date());
      if (!availability.open) {
        const nextOpenAt = availability.nextOpenAt;
        if (nextOpenAt) {
          const seconds = Math.max(1, Math.ceil((nextOpenAt.getTime() - Date.now()) / 1000));
          reply.header('retry-after', String(Math.min(seconds, 3600)));
        }
        return reply.status(503).send({
          error: 'chatbot_closed',
          detail: { next_open_at: nextOpenAt?.toISOString() ?? null },
        });
      }

      return reply.send({ ok: true });
    },
  );

  // M20: visitor email capture. Write-only at the session-bearer scope —
  // the body sets the value; no GET counterpart returns it. Admin path
  // (post-launch) can read it via a future endpoint. Fires the chatbot's
  // handoff webhook on success when terminated_at is already set; if the
  // session isn't yet terminated, the capture still persists (a visitor
  // who proactively leaves their email mid-conversation isn't denied).
  fastify.post<{ Body: { email?: unknown } }>(
    '/sessions/visitor-email',
    {
      schema: {
        tags: ['sessions'],
        summary: 'Persist a visitor email against a session (write-only)',
        description:
          'Body: `{ email }`. Session-bearer auth. Email is loosely validated ' +
          '(must contain `@` and a `.` after it). Returns 204 with no body — ' +
          'deliberately no echo, and there is no GET counterpart at this scope. ' +
          'Admin path is the only way to recall the stored value. If the session ' +
          'is already terminated and the chatbot has a `handoff_webhook_url`, the ' +
          'POST fires the webhook best-effort before returning.',
        security: [{ bearerAuth: [] }],
        response: {
          204: { type: 'null' },
          400: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const token = extractBearerToken(req.headers.authorization);
      if (!token) {
        return reply.status(401).send({ error: 'token_required' });
      }
      const session = await findSessionByToken(db, token);
      if (!session) {
        return reply.status(401).send({ error: 'invalid_token' });
      }
      const email = req.body?.email;
      if (typeof email !== 'string') {
        return reply.status(400).send({
          error: 'validation_failed',
          detail: { message: 'Body requires an `email` string.' },
        });
      }
      const trimmed = email.trim();
      // Loose RFC-ish check — no full RFC 5321 parser; just enough to catch
      // obvious garbage. Length cap matches the VARCHAR(255) column.
      if (
        trimmed.length === 0 ||
        trimmed.length > 255 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)
      ) {
        return reply.status(400).send({
          error: 'validation_failed',
          detail: { message: 'Email must be a non-empty string ≤255 chars with @ and a dot.' },
        });
      }

      await db('sessions').where({ id: session.id }).update({ visitor_email: trimmed });

      // If the session is already terminated, attempt the webhook now.
      // (If it isn't, the webhook will fire from runChat when the hard-cap
      // crosses.) The webhook is best-effort — never block on it here.
      if (session.terminated_at !== null) {
        const chatbot = await db('chatbots').where({ id: session.chatbot_id }).first();
        if (chatbot && chatbot.handoff_webhook_url) {
          const spendRow = await db('messages')
            .where({ session_id: session.id })
            .sum<{ total: string | number | null }[]>({ total: 'cost_usd_estimate' })
            .first();
          const spendUsd = Number(spendRow?.total ?? 0);
          // Refetch the session so the webhook payload carries the just-set email.
          const refreshed = await findSessionByToken(db, token);
          if (refreshed) {
            void notifyHandoff({ db, chatbot, session: refreshed, spendUsd });
          }
        }
      }

      return reply.status(204).send();
    },
  );

  fastify.get(
    '/messages',
    {
      schema: {
        tags: ['messages'],
        summary: 'Rehydrate session history',
        description:
          'Returns the full ordered list of messages for the session identified ' +
          'by the `Authorization: Bearer ...` token. Used by clients on page load ' +
          'to restore a conversation in progress.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            description: 'message history',
            type: 'object',
            properties: {
              messages: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'integer' },
                    session_id: { type: 'integer' },
                    role: { type: 'string', enum: ['user', 'assistant'] },
                    content: { type: 'string' },
                    created_at: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
            required: ['messages'],
          },
          401: errorResponseSchema,
          403: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const token = extractBearerToken(req.headers.authorization);
      if (!token) {
        return reply.status(401).send({ error: 'token_required' });
      }
      const session = await findSessionByToken(db, token);
      if (!session) {
        return reply.status(401).send({ error: 'invalid_token' });
      }
      // M21: admin-mode sessions skip the geo check throughout the chat path.
      if (!session.is_admin_mode) {
        const geo = await enforceGeo(db, session.chatbot_id, req.ip, geoChecker);
        if (!geo.allowed) {
          req.log.info(
            {
              ip: req.ip,
              country: geo.country,
              chatbotId: session.chatbot_id,
              mode: geo.mode,
              reason: geo.reason,
            },
            'GET /messages: geo_blocked',
          );
          return reply.status(403).send({ error: 'geo_blocked' });
        }
      }
      const messages = await listMessages(db, session.id);
      return reply.send({ messages });
    },
  );

  fastify.post(
    '/chat',
    {
      config: rlEnabled
        ? {
            rateLimit: { max: chatPerIp, timeWindow: '1 minute' },
          }
        : {},
      schema: {
        tags: ['chat'],
        summary: 'Send a user turn, get the assistant reply',
        description:
          'Requires `Authorization: Bearer <session_token>`. Body is a JSON object ' +
          'with a single `message` string (1–8000 chars, trimmed). The server ' +
          "persists the user message, calls the configured LLM with the chatbot's " +
          'system blocks + history, persists the assistant reply, and returns just ' +
          'the new reply. Use `GET /messages` to rehydrate the full conversation.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            description: 'assistant reply',
            type: 'object',
            properties: {
              reply: { type: 'string' },
              message_id: { type: 'integer' },
              tokens_used: {
                type: 'object',
                properties: {
                  prompt: { type: 'integer' },
                  completion: { type: 'integer' },
                },
              },
              session_terminated: {
                type: 'boolean',
                description:
                  'M20: when true, this session is closed. The visitor widget should ' +
                  'render the email-capture input. message_id may be 0 when no new ' +
                  'row was persisted (terminated session re-entered).',
              },
            },
            required: ['reply', 'message_id'],
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          413: errorResponseSchema,
          429: errorResponseSchema,
          500: errorResponseSchema,
          502: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const token = extractBearerToken(req.headers.authorization);
      if (!token) {
        return reply.status(401).send({ error: 'token_required' });
      }
      const body = req.body as { message?: unknown } | undefined;
      if (!body || typeof body.message !== 'string') {
        return reply.status(400).send({ error: 'message_required' });
      }

      // Resolve the session up-front for the geo check; runChat will look it
      // up again. Two queries, but the second is on a fresh transaction and
      // bumps last_active_at, so deduplicating isn't worth the coupling.
      const session = await findSessionByToken(db, token);
      if (!session) {
        return reply.status(401).send({ error: 'invalid_token' });
      }
      // M21: admin-mode sessions skip the geo check throughout the chat path.
      if (!session.is_admin_mode) {
        const geo = await enforceGeo(db, session.chatbot_id, req.ip, geoChecker);
        if (!geo.allowed) {
          req.log.info(
            {
              ip: req.ip,
              country: geo.country,
              chatbotId: session.chatbot_id,
              mode: geo.mode,
              reason: geo.reason,
            },
            'POST /chat: geo_blocked',
          );
          return reply.status(403).send({ error: 'geo_blocked' });
        }
      }

      // M23 per-chatbot rate limit. Per-IP cap is enforced by the
      // @fastify/rate-limit plugin via `config.rateLimit` above.
      const rlDecision = applyChatbotRateLimit(session.chatbot_id, 'chat', reply);
      if (rlDecision && !rlDecision.allowed) return;

      try {
        const result = await runChat({
          db,
          sessionToken: token,
          message: body.message,
          adapterFactory,
          sim: opts.sim,
        });
        return reply.send(result);
      } catch (err) {
        if (err instanceof ChatError) {
          const status = CHAT_ERROR_STATUS[err.code];
          const payload: Record<string, unknown> = { error: err.code };
          if (err.detail) payload.detail = err.detail;
          if (err.code === 'model_error') {
            req.log.error({ err: err.message }, 'chat model_error');
          }
          return reply.status(status).send(payload);
        }
        req.log.error(err);
        return reply.status(500).send({ error: 'internal_error' });
      }
    },
  );

  // M19 admin HTTP API. Two prefixes with different bearer-auth scopes:
  // `/admin/accounts/*` uses the deployment SW_PROVISIONING_KEY;
  // `/admin/chatbots/*` uses account-scoped admin_keys rows.
  await fastify.register(adminAccountsPlugin, { prefix: '/admin/accounts', db });
  await fastify.register(adminChatbotsPlugin, { prefix: '/admin/chatbots', db });

  return fastify;
}
