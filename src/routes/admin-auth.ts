import { timingSafeEqual } from 'node:crypto';
import type { preHandlerHookHandler } from 'fastify';
import type { Knex } from 'knex';
import { loadProvisioningKey } from '../config/secrets.js';
import { getAdminKeyByHash, hashAdminKey } from '../services/admin-keys.js';
import { extractBearerToken } from '../utils/bearer.js';

/**
 * Augments `FastifyRequest` with the scope resolved by
 * {@link makeVerifyAccountAdminBearer}. Set on every `/admin/chatbots/*`
 * request after the bearer is verified; never set on routes guarded by
 * the provisioning bearer (those don't carry account scope).
 */
declare module 'fastify' {
  interface FastifyRequest {
    adminContext?: { accountId: string };
  }
}

/**
 * Constant-time string equality via `crypto.timingSafeEqual`. Length
 * mismatch returns false fast — that's fine; `timingSafeEqual` would
 * throw on mismatched lengths anyway, and a length signal on bearer
 * tokens isn't itself useful to an attacker.
 */
function bufferTimingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * `preHandler` for `/admin/accounts/*`. Constant-time-compares the
 * incoming bearer against the cached `SW_PROVISIONING_KEY`. Refuses
 * everything when the env var is unset — self-hosters who don't run
 * WC-side provisioning leave that lane locked.
 *
 * Returns no scope (provisioning is a deployment-level credential, not
 * account-scoped).
 */
export function makeVerifyProvisioningBearer(): preHandlerHookHandler {
  return async function verifyProvisioningBearer(req, reply) {
    const provKey = loadProvisioningKey();
    if (!provKey) {
      return reply.status(401).send({ error: 'bearer_invalid' });
    }
    const bearer = extractBearerToken(req.headers.authorization);
    if (!bearer) {
      return reply.status(401).send({ error: 'bearer_required' });
    }
    if (!bufferTimingSafeEqual(bearer, provKey)) {
      return reply.status(401).send({ error: 'bearer_invalid' });
    }
    // No context to populate; provisioning is global.
  };
}

/**
 * `preHandler` for `/admin/chatbots/*`. Hashes the incoming bearer and
 * looks it up in `admin_keys`; on hit, populates
 * `req.adminContext = { accountId }` so downstream handlers can
 * cross-account-guard their resolved chatbots.
 *
 * Revoked keys collapse to `bearer_invalid` rather than a distinct
 * `bearer_revoked` code — deliberately. "Was once valid, now isn't"
 * is a tiny info leak vs. "this bearer doesn't work."
 *
 * Defensively also refuses the provisioning bearer with `wrong_scope`
 * (403) so an operator who pastes the wrong key gets a useful error
 * instead of a silent 401.
 */
export function makeVerifyAccountAdminBearer(db: Knex): preHandlerHookHandler {
  return async function verifyAccountAdminBearer(req, reply) {
    const bearer = extractBearerToken(req.headers.authorization);
    if (!bearer) {
      return reply.status(401).send({ error: 'bearer_required' });
    }

    const provKey = loadProvisioningKey();
    if (provKey && bufferTimingSafeEqual(bearer, provKey)) {
      return reply.status(403).send({ error: 'wrong_scope' });
    }

    const hash = hashAdminKey(bearer);
    const adminKey = await getAdminKeyByHash(db, hash);
    if (!adminKey) {
      return reply.status(401).send({ error: 'bearer_invalid' });
    }

    req.adminContext = { accountId: adminKey.account_id };
  };
}
