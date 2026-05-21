# Admin HTTP API + bearer-token auth

Design notes for M19, captured during the route-design pass. **Status: shipped** in v0.15.0 — the three live questions (block-name validator, api-key clear via DELETE, geo as sub-resource) resolved on 2026-05-21, routes implemented in the same session.

The operator-facing reference for the resulting HTTP surface is now [`../docs/api-admin.md`](../docs/api-admin.md). This doc is preserved as the design-conversation record; the open-question section captures what we considered and chose.

Companion to:
- [`10-saas-shape.md`](10-saas-shape.md) — auth model (two key types, air-gapped), endpoint surface sketch
- [`02-data-model.md`](02-data-model.md) — gains the `admin_keys` table in M19

---

## What's already settled

Resolved before this doc was written:

- **Two-key auth model.** Provisioning key in `.env` as `SW_PROVISIONING_KEY` (air-gapped); account admin keys live in the new `admin_keys` table with `account_id NOT NULL`. See [`10-saas-shape.md`](10-saas-shape.md) section "Why `SW_PROVISIONING_KEY` is not in `admin_keys`" for the rationale.
- **Provisioning bootstrap.** Operator generates via `sw secrets gen-provisioning-key`, pastes into `.env`. Boot validation fails loud on empty or short values.
- **Hash-at-rest for admin keys.** Raw key returned once at mint time (GitHub-PAT style); only the sha-256 hex hash sits in `admin_keys.token_hash`. Subsequent reads of the row never include the hash.
- **Cascade behaviour.** Deleting an account drops all its admin keys via FK CASCADE. Deleting a chatbot does not affect admin keys (they're scoped to the account, not the chatbot).

---

## Endpoint surface

Per [`10-saas-shape.md`](10-saas-shape.md), with the gaps from the original sketch filled in below:

```
POST   /admin/accounts                                              (provisioning)
GET    /admin/accounts                                              (provisioning)
POST   /admin/accounts/{accountId}/keys                             (provisioning)
GET    /admin/accounts/{accountId}/keys                             (provisioning)
DELETE /admin/accounts/{accountId}/keys/{keyId}                     (provisioning)

GET    /admin/chatbots                                              (account-admin)
POST   /admin/chatbots                                              (account-admin)
GET    /admin/chatbots/{slug}                                       (account-admin)
PATCH  /admin/chatbots/{slug}                                       (account-admin)
DELETE /admin/chatbots/{slug}                                       (account-admin)
GET    /admin/chatbots/{slug}/origins                               (account-admin)
POST   /admin/chatbots/{slug}/origins                               (account-admin)
DELETE /admin/chatbots/{slug}/origins/{originId}                    (account-admin)
GET    /admin/chatbots/{slug}/blocks                                (account-admin)
PUT    /admin/chatbots/{slug}/blocks/{name}                         (account-admin)
DELETE /admin/chatbots/{slug}/blocks/{name}                         (account-admin)
PATCH  /admin/chatbots/{slug}/api-key                               (account-admin)
GET    /admin/chatbots/{slug}/usage                                 (account-admin)
```

Two mountpoints: `/admin/accounts/*` (provisioning-key-gated) and `/admin/chatbots/*` (account-admin-key-gated). Different middleware for each prefix; the bearer-verification function knows which key type it's looking at by the route prefix, not by row inspection.

---

## Open questions

Each has my lean. The operator green-lights or overrides; the foundation layer being written today doesn't bake any of these in.

### 1. Route identifier shape

`/admin/accounts/{accountId}` clearly takes the UUID (accounts have no slug-as-route-key; UUID is the natural addressable id, and it's what `site-walker-for-woo` will quote when calling back).

`/admin/chatbots/{slug}` vs `/admin/chatbots/{chatbotId}` — chatbots have **both** a human-readable slug and an integer id. Two arguments:

- **Slug** matches the CLI surface (`sw chatbot show <slug>`), is stable per the schema (UNIQUE), and is what operators copy-paste from `sw chatbot list`. URL is human-readable.
- **Integer id** is opaque, stable, and never collides; URL is "post-y" in the way that `/admin/accounts/{id}` is.

**Lean: slug.** Operators are the audience; matching the CLI gives one less translation step. The trade is that renaming a chatbot would change its admin URL, but we don't currently expose a "rename" operation and rename is a real semantic break anyway.

### 2. PATCH /admin/chatbots/{slug} field allowlist

Which chatbot fields are updatable via HTTP? Current schema columns:

| Column                       | Allow via PATCH? | Note                                                                              |
|------------------------------|------------------|-----------------------------------------------------------------------------------|
| `account_id`                 | **No**           | Cross-account move; out of scope. Maybe a future operator-only endpoint.          |
| `slug`                       | **No**           | The URL identifier. Renaming breaks the admin URL + any operator scripts.         |
| `name`                       | Yes              | Cosmetic; cheap to allow.                                                         |
| `welcome_message`            | Yes              | Same as `sw chatbot set-welcome`.                                                 |
| `persona`                    | Yes              | Same as `sw chatbot set-persona`.                                                 |
| `model_slug`                 | Yes (validated)  | Must resolve against the DB-backed provider registry. Reuse `setModel` logic.     |
| `model_parameters`           | Yes (validated)  | Through `NormalisedParametersSchema`. Reuse `setParameters`.                      |
| `model_context_window`       | Yes              | Through `setContextWindow`. Operator override on the registry default.            |
| `geo_mode_id` / geo settings | Probably         | Via `setChatbotGeoMode` + `setChatbotGeoCountries`. Possibly its own sub-endpoint? |
| `provider_api_key_*`         | **No via PATCH** | Has its own endpoint (`PATCH /admin/chatbots/{slug}/api-key`) for clarity.        |

**Lean: yes/no column matches the table above.** Geo settings probably warrant their own sub-resource for symmetry with origins and blocks; sketch below.

Possible geo sub-routes (TBD):
```
GET    /admin/chatbots/{slug}/geo
PATCH  /admin/chatbots/{slug}/geo                  # { mode: "blocklist", countries: ["RU", "CN"] }
```

### 3. PATCH /admin/chatbots/{slug}/api-key request shape

Setting a chatbot's BYO LLM key over HTTP. The CLI's `sw chatbot set-api-key` reads from stdin to avoid argv-logging. HTTP equivalent: pass the raw key in the request body.

**Lean: JSON body `{ "api_key": "sk-..." }`**. Plain text in the body is acceptable because:

- TLS is the only acceptable transport for `/admin/*` in production (operator responsibility; we document it).
- The body never gets logged at the route layer (need to ensure fastify's request logger doesn't capture POST/PATCH bodies — set body logging off for /admin/*).
- Same encrypt-on-receive semantics as the CLI; raw key never persisted plaintext.

**Open sub-question:** if the operator wants to clear a key (remove it without setting a new one), should `PATCH /admin/chatbots/{slug}/api-key` accept `{ "api_key": null }` or should that be `DELETE /admin/chatbots/{slug}/api-key`?

**Lean:** `DELETE` for clear. Cleaner verb; matches the resource pattern. So:

```
PATCH  /admin/chatbots/{slug}/api-key    { "api_key": "..." }    # set
DELETE /admin/chatbots/{slug}/api-key                            # clear
```

### 4. PUT /admin/chatbots/{slug}/blocks/{name} validation

Body is the markdown content of a system block. Need:

- **Block-name validation.** Filesystem-safe; matches the existing `loadDiskBlocks` convention. Pattern `^[A-Z0-9_-]+$` — uppercase letters, digits, hyphens, underscores. Rejects path-traversal attempts and reserved names like `PERSONA` (the persona has its own DB column + PATCH route).
- **Content-type.** `text/markdown` or `text/plain` accepted; reject other types with 415.
- **Size cap.** Some upper bound — say 64KB per block, matching nothing in particular but a sensible operator-side guard. Configurable later if needed.
- **Storage.** Write to `data/chatbots/<slug>/<name>.md`. Same path `loadDiskBlocks` expects.

**Lean: ship as described.** The `text/markdown` accept is a small ergonomic win; we don't actually parse markdown anywhere, but it labels the body honestly.

`DELETE /admin/chatbots/{slug}/blocks/{name}` removes the file. 404 if it doesn't exist.

`GET /admin/chatbots/{slug}/blocks` returns the list of block names (no content) plus the persona indicator. Body content fetch could be `GET /admin/chatbots/{slug}/blocks/{name}` — useful for the WP plugin to verify what it last pushed. **Lean: yes, add the GET-single-block.**

### 5. Admin-key token format

The raw key returned by `POST /admin/accounts/{accountId}/keys` (and the CLI mint). What does it look like?

Industry conventions: GitHub `ghp_<...>`, Stripe `sk_live_<...>`, Anthropic `sk-ant-<...>`. The prefix is for human recognisability + grep'ing logs to spot leaks.

**Lean:** `sw_<base64url-32-bytes>` — total ~46 chars. Prefix `sw_` for "site-walker." The hashed-and-stored form is sha-256-hex (64 chars) of the entire string (prefix included), so verification doesn't have to strip the prefix.

**Open sub-question:** distinguish provisioning keys from account admin keys via prefix? E.g. `sw_prov_<...>` vs `sw_<...>`? Probably not — `SW_PROVISIONING_KEY` lives in env and is never confused with a DB-resident admin key in practice. Keep one prefix.

### 6. Admin-key revocation: id or token-prefix?

Operator runs `sw account revoke-admin-key <account-slug> <ref>`. What's `<ref>`?

- **id** (the UUID stored in `admin_keys.id`) — opaque, stable, never collides. Operator runs `sw account list-admin-keys` first to find the id.
- **token-prefix** (first N chars of the raw key, or first N chars of the hash) — operator can identify the key from a record of "the key starts with abc..." without crosschecking.

**Lean: id.** It's what the list view shows; one consistent identifier per row. The token prefix shape would be ambiguous on hash-prefix collision (low odds but real).

Same applies to the HTTP equivalent: `DELETE /admin/accounts/{accountId}/keys/{adminKeyId}` where `{adminKeyId}` is the UUID.

### 7. Error response shapes

Reuse the existing typed-error pattern: `{ "error": "code", "detail"?: {} }`. Concrete codes for `/admin/*`:

| Status | Code                          | When                                                                    |
|--------|-------------------------------|-------------------------------------------------------------------------|
| 400    | `validation_failed`           | Bad JSON, missing required field, field fails Zod schema.               |
| 401    | `bearer_required`             | No `Authorization: Bearer …` header.                                    |
| 401    | `bearer_invalid`              | Bearer doesn't match any active admin_keys row (or provisioning hash).  |
| 403    | `bearer_revoked`              | Bearer matches a row but `revoked_at IS NOT NULL`.                      |
| 403    | `wrong_scope`                 | Account-admin key used on `/admin/accounts/*`, or vice versa.           |
| 403    | `cross_account`               | Account-admin key accessing a chatbot not in its account.               |
| 404    | `not_found`                   | Requested resource doesn't exist.                                       |
| 409    | `conflict`                    | Unique-constraint violation (e.g. duplicate origin, slug already taken).|
| 503    | `chatbot_api_key_missing`     | Existing M17 code; surfaces here if any admin route triggers a chat-path check. |

**Lean: ship as described.** Codes mirror the typed-error pattern from `/sessions` and `/chat`; widget developers (and `site-walker-for-woo` developers) get one error vocabulary.

### 8. Last-used tracking

`admin_keys.last_used_at` updated on every successful bearer-auth check. Operator load (not user load), so an extra UPDATE per request is fine for v1. Don't batch.

**Lean: ship as described.** If profiling shows this is hot under M19+ load (unlikely — operator traffic is light), batch in M11's Redis layer.

### 9. OpenAPI schema augmentation

Every `/admin/*` route documented in the OpenAPI surface served at `/openapi.json`. New `admin` tag in the spec. Body schemas defined inline (not extracted into `components/schemas` unless reuse demands it).

Bearer auth applied per-route via the existing `securitySchemes.bearerAuth` declaration; M19 doesn't introduce a second scheme.

### 10. Concurrent route mounting strategy

Fastify-side: register two route prefixes with different `preHandler` middleware:

- `/admin/accounts/*` — `preHandler: verifyProvisioningBearer`
- `/admin/chatbots/*` — `preHandler: verifyAccountAdminBearer`

The bearer-verification function in each case is responsible for the 401/403 typed errors. Routes themselves assume `req.adminContext` (account-admin path) or `req.provisioningContext` (provisioning path) is populated by the time the handler runs.

**Lean: ship as described.** Cleaner than per-route middleware decoration; matches Fastify idiom.

---

## What this doc is not

- **Not the implementation plan.** The M19 implementation phasing lands in `00-project-tracker.md` once these questions resolve.
- **Not a public API spec.** OpenAPI is the source of truth for that once routes ship.
- **Not blocking the foundation work.** The non-route pieces (admin_keys schema, SW_PROVISIONING_KEY loader, service layer, CLI helpers) can — and are being — built in parallel with this doc; none of them bake the open questions in.
