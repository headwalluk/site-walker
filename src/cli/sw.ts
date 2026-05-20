import { Command } from 'commander';
import { assertEnvFilePermissions } from '../utils/env.js';
import { db } from '../db/index.js';

assertEnvFilePermissions();
import {
  addOrigin,
  createChatbot,
  deleteChatbot,
  getChatbotBySlug,
  listOrigins,
  listChatbots,
  removeOrigin,
  setPersona,
  setWelcomeMessage,
} from '../services/chatbots.js';
import {
  createAccount,
  deleteAccount,
  getAccountBySlug,
  listAccounts,
} from '../services/accounts.js';
import { findSessionByTokenOrId, listMessages, listSessions } from '../services/sessions.js';
import { assemblePrompt, loadDiskBlocks } from '../services/system-blocks.js';
import { resolveModel, setContextWindow, setModel, setParameters } from '../services/models.js';
import { getChatbotUsage, parseSinceDuration } from '../services/cost.js';
import { findProviderModel } from '../services/providers.js';
import { parseModelSlug } from '../providers/index.js';
import { listProviderModels } from '../providers/list-models.js';
import { DEFAULT_OPENROUTER_BASE_URL } from '../providers/openrouter.js';
import {
  SUPPORTED_PROTOCOLS,
  createProvider,
  createProviderModel,
  deleteProvider,
  deleteProviderModel,
  getProviderByName,
  listProviderModelsForProvider,
  listProviders,
} from '../services/providers.js';
import {
  getChatbotGeoSummary,
  setChatbotGeoCountries,
  setChatbotGeoMode,
} from '../services/geo.js';
import { readPersonaTemplate } from '../utils/templates.js';
import { encrypt, generateMasterKey } from '../utils/crypto.js';
import { loadEncryptionKey } from '../config/secrets.js';

const program = new Command();

program.name('sw').description('site-walker admin CLI').version('0.14.0');

// -----------------------------------------------------------------------------
// secrets subgroup
// -----------------------------------------------------------------------------

const secrets = program
  .command('secrets')
  .description(
    'manage env-resident master secrets (SW_ENCRYPTION_KEY today; SW_PROVISIONING_KEY in M19)',
  );

secrets
  .command('gen-key')
  .description('print a fresh base64 32-byte SW_ENCRYPTION_KEY value to stdout')
  .action(async () => {
    try {
      const key = generateMasterKey();
      // Print just the value to stdout so it can be piped or captured cleanly;
      // the hint goes to stderr so the operator sees it but it doesn't pollute
      // the captured value.
      console.log(key.toString('base64'));
      console.error('# Paste the value above into your .env as SW_ENCRYPTION_KEY=...');
      console.error('# Treat the value like any other production secret — do not commit it.');
    } finally {
      await db.destroy();
    }
  });

// -----------------------------------------------------------------------------
// account subgroup
// -----------------------------------------------------------------------------

const account = program.command('account').description('manage accounts (own chatbots)');

account
  .command('create')
  .argument('<slug>', 'URL-safe slug, e.g. headwall')
  .option('-n, --name <name>', 'human-readable name (defaults to slug)')
  .action(async (slug: string, opts: { name?: string }) => {
    try {
      const row = await createAccount(db, { slug, name: opts.name ?? slug });
      console.log(`Created account: id=${row.id} slug=${row.slug} name="${row.name}"`);
    } finally {
      await db.destroy();
    }
  });

account
  .command('list')
  .description('list all accounts (slug, name, chatbot count)')
  .action(async () => {
    try {
      const rows = await listAccounts(db);
      if (rows.length === 0) {
        console.log('(no accounts)');
        return;
      }
      const counts = await db('chatbots')
        .select('account_id')
        .count<{ account_id: string; n: string | number }[]>({ n: '*' })
        .groupBy('account_id');
      const countByAccountId = new Map<string, number>(
        counts.map((r) => [r.account_id, Number(r.n)]),
      );
      const slugW = Math.max(4, ...rows.map((r) => r.slug.length));
      const nameW = Math.max(4, ...rows.map((r) => r.name.length));
      console.log(`${'slug'.padEnd(slugW)}  ${'name'.padEnd(nameW)}  chatbots  id`);
      for (const r of rows) {
        const n = countByAccountId.get(r.id) ?? 0;
        console.log(
          `${r.slug.padEnd(slugW)}  ${r.name.padEnd(nameW)}  ${String(n).padStart(8)}  ${r.id}`,
        );
      }
    } finally {
      await db.destroy();
    }
  });

account
  .command('show')
  .argument('<slug>', 'account slug')
  .action(async (slug: string) => {
    try {
      const row = await getAccountBySlug(db, slug);
      if (!row) {
        console.error(`Account not found: slug="${slug}"`);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(row, null, 2));
    } finally {
      await db.destroy();
    }
  });

account
  .command('delete')
  .description('delete an account and CASCADE through all its chatbots + sessions + messages')
  .argument('<slug>', 'account slug')
  .option('-f, --force', 'required — irreversible; cascades to every chatbot the account owns')
  .action(async (slug: string, opts: { force?: boolean }) => {
    try {
      if (!opts.force) {
        console.error(
          `Refusing to delete account "${slug}" without --force.\n` +
            `Pass -f|--force to confirm. This cascades to every chatbot, every session, every message.`,
        );
        process.exitCode = 1;
        return;
      }
      const counts = await deleteAccount(db, slug);
      console.log(
        `Deleted account slug="${slug}". Cascaded: ${counts.chatbots} chatbot(s), ` +
          `${counts.origins} origin(s), ${counts.sessions} session(s), ${counts.messages} message(s).`,
      );
    } finally {
      await db.destroy();
    }
  });

// -----------------------------------------------------------------------------
// chatbot subgroup (was: website)
// -----------------------------------------------------------------------------

const chatbot = program.command('chatbot').description('manage chatbots');

chatbot
  .command('create')
  .argument('<slug>', 'URL-safe slug, e.g. acme-corp')
  .requiredOption('-a, --account <slug>', 'account slug that will own this chatbot')
  .option('-n, --name <name>', 'human-readable name (defaults to slug)')
  .action(async (slug: string, opts: { account: string; name?: string }) => {
    try {
      const account = await getAccountBySlug(db, opts.account);
      if (!account) {
        console.error(
          `Account not found: slug="${opts.account}". ` +
            `Create one first with: sw account create ${opts.account}`,
        );
        process.exitCode = 1;
        return;
      }
      const persona = await readPersonaTemplate();
      const row = await createChatbot(db, {
        account_id: account.id,
        slug,
        name: opts.name ?? slug,
        persona,
      });
      console.log(
        `Created chatbot: id=${row.id} slug=${row.slug} name="${row.name}" ` +
          `account="${account.slug}"`,
      );
      console.log(`Persona seeded from templates/PERSONA.md (${persona.length} chars).`);
    } finally {
      await db.destroy();
    }
  });

chatbot
  .command('list')
  .description('list all chatbots (slug, name, account, model, origin count)')
  .action(async () => {
    try {
      const rows = await listChatbots(db);
      if (rows.length === 0) {
        console.log('(no chatbots)');
        return;
      }
      const counts = await db('chatbot_origins')
        .select('chatbot_id')
        .count<{ chatbot_id: number; n: string | number }[]>({ n: '*' })
        .groupBy('chatbot_id');
      const countByChatbotId = new Map<number, number>(
        counts.map((r) => [r.chatbot_id, Number(r.n)]),
      );
      const accountSlugById = new Map<string, string>(
        (await db('accounts').select('id', 'slug')).map((r) => [r.id as string, r.slug as string]),
      );
      const slugW = Math.max(4, ...rows.map((r) => r.slug.length));
      const nameW = Math.max(4, ...rows.map((r) => r.name.length));
      const acctW = Math.max(
        7,
        ...rows.map((r) => (accountSlugById.get(r.account_id) ?? '').length),
      );
      console.log(
        `${'slug'.padEnd(slugW)}  ${'name'.padEnd(nameW)}  ${'account'.padEnd(acctW)}  ` +
          `${'model'.padEnd(28)}  origins`,
      );
      for (const r of rows) {
        const model = r.model_slug ?? '(unset)';
        const origins = countByChatbotId.get(r.id) ?? 0;
        const acct = accountSlugById.get(r.account_id) ?? '(orphaned)';
        console.log(
          `${r.slug.padEnd(slugW)}  ${r.name.padEnd(nameW)}  ${acct.padEnd(acctW)}  ` +
            `${model.padEnd(28)}  ${origins}`,
        );
      }
    } finally {
      await db.destroy();
    }
  });

chatbot
  .command('show')
  .argument('<slug>', 'chatbot slug')
  .action(async (slug: string) => {
    try {
      const row = await getChatbotBySlug(db, slug);
      if (!row) {
        console.error(`Chatbot not found: slug="${slug}"`);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(row, null, 2));
    } finally {
      await db.destroy();
    }
  });

chatbot
  .command('delete')
  .description('delete a chatbot and everything that references it (cascade)')
  .argument('<slug>', 'chatbot slug')
  .option('-f, --force', 'required — irreversible, deletes origins/sessions/messages too')
  .action(async (slug: string, opts: { force?: boolean }) => {
    try {
      if (!opts.force) {
        console.error(
          `Refusing to delete chatbot "${slug}" without --force.\n` +
            `Pass -f|--force to confirm. This cascades to origins, sessions, and messages.`,
        );
        process.exitCode = 1;
        return;
      }
      const counts = await deleteChatbot(db, slug);
      console.log(
        `Deleted chatbot slug="${slug}". Cascaded: ${counts.origins} origin(s), ` +
          `${counts.sessions} session(s), ${counts.messages} message(s).`,
      );
    } finally {
      await db.destroy();
    }
  });

chatbot
  .command('set-welcome')
  .description(
    'set the welcome message returned by POST /sessions (empty string clears to default)',
  )
  .argument('<slug>', 'chatbot slug')
  .argument('<message>', 'welcome message text; empty string clears back to the default')
  .action(async (slug: string, message: string) => {
    try {
      const row = await setWelcomeMessage(db, slug, message);
      if (row.welcome_message === null) {
        console.log(`Cleared welcome_message for slug="${slug}" (falls back to default).`);
      } else {
        console.log(
          `Set welcome_message for slug="${slug}" (${row.welcome_message.length} chars).`,
        );
      }
    } finally {
      await db.destroy();
    }
  });

const origins = chatbot
  .command('origins')
  .description("manage a chatbot's origin allowlist (list/add/remove)");

origins
  .command('list')
  .argument('<slug>', 'chatbot slug')
  .action(async (slug: string) => {
    try {
      const rows = await listOrigins(db, slug);
      if (rows.length === 0) {
        console.log(`(no origins configured for slug="${slug}")`);
        return;
      }
      const idW = Math.max(2, ...rows.map((r) => String(r.id).length));
      console.log(`${'id'.padStart(idW)}  origin`);
      for (const r of rows) {
        console.log(`${String(r.id).padStart(idW)}  ${r.origin}`);
      }
    } finally {
      await db.destroy();
    }
  });

origins
  .command('add')
  .argument('<slug>', 'chatbot slug')
  .argument('<origin>', 'origin URL (scheme + host only, e.g. https://example.com)')
  .action(async (slug: string, origin: string) => {
    try {
      const row = await addOrigin(db, slug, origin);
      console.log(`Added origin id=${row.id} origin="${row.origin}" to chatbot slug="${slug}"`);
    } finally {
      await db.destroy();
    }
  });

origins
  .command('remove')
  .argument('<slug>', 'chatbot slug')
  .argument('<origin-or-id>', 'origin URL or numeric chatbot_origins.id')
  .action(async (slug: string, ref: string) => {
    try {
      const row = await removeOrigin(db, slug, ref);
      console.log(`Removed origin id=${row.id} origin="${row.origin}" from slug="${slug}"`);
    } finally {
      await db.destroy();
    }
  });

chatbot
  .command('set-persona')
  .argument('<slug>', 'chatbot slug')
  .argument('<persona-text>', 'persona text to store on the chatbot')
  .action(async (slug: string, personaText: string) => {
    try {
      const row = await setPersona(db, slug, personaText);
      console.log(`Updated persona for slug="${row.slug}" (${personaText.length} chars).`);
    } finally {
      await db.destroy();
    }
  });

chatbot
  .command('set-model')
  .argument('<slug>', 'chatbot slug')
  .argument('<model-slug>', 'provider/model, e.g. cortex/qwen2:1.5b')
  .action(async (slug: string, modelSlug: string) => {
    try {
      const row = await setModel(db, slug, modelSlug);
      console.log(`Set model_slug="${row.model_slug}" for chatbot slug="${row.slug}".`);
    } finally {
      await db.destroy();
    }
  });

chatbot
  .command('set-api-key')
  .description("encrypt and store this chatbot's BYO LLM provider API key. Reads from stdin only.")
  .argument('<slug>', 'chatbot slug')
  .action(async (slug: string) => {
    try {
      if (process.stdin.isTTY) {
        console.error(
          'sw chatbot set-api-key reads from stdin only. Pipe the key — for example:\n' +
            `  echo "sk-ant-..." | ./bin/sw chatbot set-api-key ${slug}\n` +
            'or:\n' +
            `  ./bin/sw chatbot set-api-key ${slug} < ~/secrets/key.txt`,
        );
        process.exitCode = 1;
        return;
      }
      const chatbot = await getChatbotBySlug(db, slug);
      if (!chatbot) {
        console.error(`Chatbot not found: slug="${slug}"`);
        process.exitCode = 1;
        return;
      }
      const raw = await readAllStdin();
      const apiKey = raw.trim();
      if (apiKey.length === 0) {
        console.error(`No api_key value read from stdin. Aborting; no change made.`);
        process.exitCode = 1;
        return;
      }
      const plaintextBytes = Buffer.byteLength(apiKey, 'utf8');
      // VARBINARY(255) on the ciphertext column; AES-GCM ciphertext is byte-
      // for-byte the same length as plaintext, so this cap is exact.
      if (plaintextBytes > 255) {
        console.error(
          `api_key is ${plaintextBytes} bytes; the ciphertext column is VARBINARY(255). ` +
            `Refusing to truncate.`,
        );
        process.exitCode = 1;
        return;
      }
      const masterKey = loadEncryptionKey();
      const secret = encrypt(apiKey, masterKey);
      await db('chatbots').where({ id: chatbot.id }).update({
        provider_api_key_ciphertext: secret.ciphertext,
        provider_api_key_nonce: secret.nonce,
        provider_api_key_auth_tag: secret.authTag,
      });
      // Never print the key, the ciphertext, or any prefix of either.
      console.log(
        `Set api_key for chatbot slug="${slug}" (${plaintextBytes} bytes stored encrypted).`,
      );
    } finally {
      await db.destroy();
    }
  });

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

chatbot
  .command('set-parameters')
  .argument('<slug>', 'chatbot slug')
  .argument('<json>', 'JSON object of normalised parameters, e.g. \'{"temperature":0.7}\'')
  .action(async (slug: string, json: string) => {
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch (err) {
        throw new Error(`<json> is not valid JSON: ${(err as Error).message}`, { cause: err });
      }
      const row = await setParameters(db, slug, parsed);
      console.log(
        `Set model_parameters for chatbot slug="${row.slug}": ${JSON.stringify(row.model_parameters)}`,
      );
    } finally {
      await db.destroy();
    }
  });

chatbot
  .command('set-context-window')
  .argument('<slug>', 'chatbot slug')
  .argument('<tokens>', 'declared context window, in tokens')
  .action(async (slug: string, tokens: string) => {
    try {
      const n = Number(tokens);
      const row = await setContextWindow(db, slug, n);
      console.log(`Set model_context_window=${row.model_context_window} for slug="${row.slug}".`);
    } finally {
      await db.destroy();
    }
  });

chatbot
  .command('show-model')
  .argument('<slug>', 'chatbot slug')
  .action(async (slug: string) => {
    try {
      const row = await getChatbotBySlug(db, slug);
      if (!row) {
        console.error(`Chatbot not found: slug="${slug}"`);
        process.exitCode = 1;
        return;
      }
      if (!row.model_slug) {
        console.log(`Chatbot "${slug}" has no model_slug set.`);
        return;
      }
      const resolved = await resolveModel(db, row);
      console.log(`Chatbot: ${resolved.chatbotSlug}`);
      console.log(`  model_slug:           ${resolved.modelSlug}`);
      console.log(
        `  provider:             ${resolved.provider.name} (${resolved.provider.protocol})` +
          (resolved.provider.is_metered ? ' [metered]' : ' [unmetered]'),
      );
      console.log(`  model:                ${resolved.model}`);
      console.log(`  parameters:           ${JSON.stringify(resolved.parameters)}`);
      console.log(`  model_context_window: ${resolved.contextWindow ?? '(unset)'}`);
    } finally {
      await db.destroy();
    }
  });

chatbot
  .command('usage')
  .description('aggregate token + USD cost totals for a chatbot, optionally over a recent window')
  .argument('<slug>', 'chatbot slug')
  .option(
    '-s, --since <duration>',
    'relative window — Ns / Nm / Nh / Nd. Defaults to all-time when omitted.',
  )
  .action(async (slug: string, opts: { since?: string }) => {
    try {
      const chatbotRow = await getChatbotBySlug(db, slug);
      if (!chatbotRow) {
        console.error(`Chatbot not found: slug="${slug}"`);
        process.exitCode = 1;
        return;
      }

      let since: Date | undefined;
      let periodLabel = 'all-time';
      if (opts.since) {
        try {
          since = parseSinceDuration(opts.since);
          periodLabel = `last ${opts.since} (since ${since.toISOString()})`;
        } catch (err) {
          console.error((err as Error).message);
          process.exitCode = 1;
          return;
        }
      }

      const usage = await getChatbotUsage(db, chatbotRow.id, since);

      console.log(`Usage for chatbot "${slug}" (period: ${periodLabel}):`);
      console.log(`  Messages:        ${usage.messageCount}`);
      console.log(`  Tokens in:       ${usage.tokensIn}`);
      console.log(`  Tokens out:      ${usage.tokensOut}`);
      console.log(`  Cost (USD est):  $${usage.costUsd.toFixed(6)}`);

      if (usage.cacheReadTokens > 0 || usage.cacheCreationTokens > 0) {
        console.log('');
        console.log(`  Cache writes:    ${usage.cacheCreationTokens} tokens`);
        console.log(`  Cache reads:     ${usage.cacheReadTokens} tokens`);
      }

      // Warn when the chatbot's current model is on a metered provider but
      // has NULL pricing — cost computation silently yields 0 in that case,
      // so the totals above under-count actual spend at the provider.
      if (chatbotRow.model_slug) {
        const { provider: providerName, model: modelPart } = parseModelSlug(chatbotRow.model_slug);
        const found = await findProviderModel(db, providerName, modelPart);
        if (
          found &&
          found.provider.is_metered &&
          (found.model.input_per_million_usd === null ||
            found.model.output_per_million_usd === null)
        ) {
          console.log('');
          console.log(
            `  ⚠ Cost may be under-counted: chatbot's current model row ` +
              `"${providerName}/${modelPart}" has NULL pricing on metered provider ` +
              `"${providerName}". Re-register the model with --input-price and ` +
              `--output-price to get accurate cost numbers going forward.`,
          );
        }
      }
    } finally {
      await db.destroy();
    }
  });

chatbot
  .command('set-geo-mode')
  .description("set a chatbot's geo-blocking mode (allowall|blocklist|allowlist)")
  .argument('<slug>', 'chatbot slug')
  .argument('<mode>', 'one of: allowall, blocklist, allowlist')
  .action(async (slug: string, mode: string) => {
    try {
      const result = await setChatbotGeoMode(db, slug, mode);
      console.log(`Set geo mode for slug="${slug}" to "${result.modeCode}".`);
      if (result.modeCode !== 'allowall') {
        console.log('(Remember to populate the country list with `sw chatbot set-geo-countries`.)');
      }
    } finally {
      await db.destroy();
    }
  });

chatbot
  .command('set-geo-countries')
  .description("set a chatbot's geo country list (comma-separated ISO codes; empty clears)")
  .argument('<slug>', 'chatbot slug')
  .argument('<codes>', 'comma-separated ISO 3166-1 alpha-2 codes (e.g. "GB,US,FR"); empty clears')
  .action(async (slug: string, codes: string) => {
    try {
      const list = codes
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const result = await setChatbotGeoCountries(db, slug, list);
      if (result.countries.length === 0) {
        console.log(`Cleared geo country list for slug="${slug}".`);
      } else {
        console.log(
          `Set geo country list for slug="${slug}": ${result.countries.join(', ')} ` +
            `(${result.countries.length} ${result.countries.length === 1 ? 'country' : 'countries'}).`,
        );
      }
    } finally {
      await db.destroy();
    }
  });

chatbot
  .command('show-geo')
  .description("show a chatbot's geo-blocking mode + country list")
  .argument('<slug>', 'chatbot slug')
  .action(async (slug: string) => {
    try {
      const summary = await getChatbotGeoSummary(db, slug);
      console.log(`Geo policy for slug="${summary.slug}":`);
      console.log(`  mode:      ${summary.modeCode}`);
      if (summary.modeCode === 'allowall') {
        console.log(`  countries: (ignored in allowall mode)`);
      } else if (summary.countries.length === 0) {
        console.log(`  countries: (none — list is empty)`);
      } else {
        console.log(`  countries: ${summary.countries.join(', ')}`);
      }
    } finally {
      await db.destroy();
    }
  });

// -----------------------------------------------------------------------------
// provider subgroup (DB-backed registry, M17 onwards)
// -----------------------------------------------------------------------------

const provider = program.command('provider').description('manage the DB-backed provider registry');

provider
  .command('add')
  .description('register a new provider in the DB registry')
  .argument('<name>', 'provider name (URL-safe slug; appears as the prefix in model_slug)')
  .requiredOption(
    '-p, --protocol <protocol>',
    `wire protocol — one of: ${SUPPORTED_PROTOCOLS.join(', ')}`,
  )
  .option(
    '-u, --base-url <url>',
    'endpoint root (required for ollama-native; defaults to https://openrouter.ai/api/v1 for openrouter)',
  )
  .option('--local', 'mark this provider as LAN-only (defaults is_metered to false)')
  .option('--metered', 'force is_metered=true (overrides the !is_local default)')
  .option('--unmetered', 'force is_metered=false (Ollama or other free-tier provider)')
  .action(
    async (
      name: string,
      opts: {
        protocol: string;
        baseUrl?: string;
        local?: boolean;
        metered?: boolean;
        unmetered?: boolean;
      },
    ) => {
      try {
        if (opts.metered && opts.unmetered) {
          console.error('Pass either --metered or --unmetered, not both.');
          process.exitCode = 1;
          return;
        }
        let baseUrl = opts.baseUrl;
        if (!baseUrl && opts.protocol === 'openrouter') {
          baseUrl = DEFAULT_OPENROUTER_BASE_URL;
        }
        if (!baseUrl) {
          console.error(
            `--base-url is required for protocol "${opts.protocol}". ` +
              `(Defaults are only filled in for openrouter.)`,
          );
          process.exitCode = 1;
          return;
        }
        // Resolve is_metered: explicit flag wins; otherwise let createProvider
        // fall back to !is_local. Distinct flag names (not commander's --no-X
        // auto-negate) so that omitting both leaves `is_metered` undefined
        // here, rather than commander silently defaulting it to true.
        let is_metered: boolean | undefined;
        if (opts.metered) is_metered = true;
        else if (opts.unmetered) is_metered = false;

        const row = await createProvider(db, {
          name,
          protocol: opts.protocol,
          base_url: baseUrl,
          is_local: opts.local ?? false,
          is_metered,
        });
        console.log(
          `Created provider: id=${row.id} name=${row.name} protocol=${row.protocol} ` +
            `base_url=${row.base_url} is_local=${row.is_local} is_metered=${row.is_metered}`,
        );
      } finally {
        await db.destroy();
      }
    },
  );

provider
  .command('list')
  .description('list providers in the DB registry (with per-provider model counts)')
  .action(async () => {
    try {
      const rows = await listProviders(db);
      if (rows.length === 0) {
        console.log('(no providers defined — add one with `sw provider add`)');
        return;
      }
      const counts = await db('provider_models')
        .select('provider_id')
        .count<{ provider_id: number; n: string | number }[]>({ n: '*' })
        .groupBy('provider_id');
      const countByProviderId = new Map<number, number>(
        counts.map((r) => [r.provider_id, Number(r.n)]),
      );
      const nameW = Math.max(8, ...rows.map((r) => r.name.length));
      const protoW = Math.max(10, ...rows.map((r) => r.protocol.length));
      const urlW = Math.max(8, ...rows.map((r) => r.base_url.length));
      console.log(
        `${'name'.padEnd(nameW)}  ${'protocol'.padEnd(protoW)}  ${'base_url'.padEnd(urlW)}  ` +
          `local  metered  models`,
      );
      for (const r of rows) {
        const local = r.is_local ? 'yes' : 'no';
        const metered = r.is_metered ? 'yes' : 'no';
        const count = countByProviderId.get(r.id) ?? 0;
        console.log(
          `${r.name.padEnd(nameW)}  ${r.protocol.padEnd(protoW)}  ${r.base_url.padEnd(urlW)}  ` +
            `${local.padEnd(5)}  ${metered.padEnd(7)}  ${count}`,
        );
      }
    } finally {
      await db.destroy();
    }
  });

provider
  .command('show')
  .description('dump a provider row as JSON')
  .argument('<name>', 'provider name')
  .action(async (name: string) => {
    try {
      const row = await getProviderByName(db, name);
      if (!row) {
        console.error(`Provider not found: name="${name}"`);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(row, null, 2));
    } finally {
      await db.destroy();
    }
  });

provider
  .command('remove')
  .description('delete a provider and CASCADE through its provider_models rows')
  .argument('<name>', 'provider name')
  .option('-f, --force', 'required — irreversible; deletes all provider_models rows too')
  .action(async (name: string, opts: { force?: boolean }) => {
    try {
      if (!opts.force) {
        console.error(
          `Refusing to remove provider "${name}" without --force.\n` +
            `Pass -f|--force to confirm. This cascades to every provider_models row.`,
        );
        process.exitCode = 1;
        return;
      }
      const counts = await deleteProvider(db, name);
      console.log(
        `Removed provider name="${name}". Cascaded: ${counts.models} provider_model row(s).`,
      );
    } finally {
      await db.destroy();
    }
  });

const providerModels = provider
  .command('models')
  .description('manage the local provider_models registry (add/list/remove) + live discovery');

providerModels
  .command('discover')
  .description(
    'query a registered provider for the models it serves (copy-pasteable into `set-model`)',
  )
  .argument('<provider>', 'provider name (from `sw provider list`)')
  .option('-f, --filter <substring>', 'case-insensitive substring filter against model id + label')
  .action(async (name: string, opts: { filter?: string }) => {
    try {
      const entry = await getProviderByName(db, name);
      if (!entry) {
        console.error(
          `Provider not found: name="${name}". Register it first with \`sw provider add\`.`,
        );
        process.exitCode = 1;
        return;
      }

      const models = await listProviderModels({
        name: entry.name,
        protocol: entry.protocol,
        base_url: entry.base_url,
      });
      const filter = opts.filter?.toLowerCase();
      const filtered = filter
        ? models.filter(
            (m) =>
              m.id.toLowerCase().includes(filter) ||
              (m.label?.toLowerCase().includes(filter) ?? false),
          )
        : models;

      if (filtered.length === 0) {
        console.log(
          filter
            ? `(no models on "${name}" match filter "${opts.filter}")`
            : `(no models reported by "${name}")`,
        );
        return;
      }

      const slugW = Math.max(12, ...filtered.map((m) => `${entry.name}/${m.id}`.length));
      console.log(`Models on provider "${entry.name}" (protocol=${entry.protocol}):`);
      for (const m of filtered) {
        const slug = `${entry.name}/${m.id}`.padEnd(slugW);
        const ctx = m.contextWindow ? `ctx=${m.contextWindow}` : '';
        const ctxCol = ctx.padEnd(14);
        const label = m.label ?? '';
        console.log(`  ${slug}  ${ctxCol}  ${label}`.trimEnd());
      }
      console.log(
        `\nTotal: ${filtered.length}` +
          (filter && filtered.length !== models.length
            ? ` (of ${models.length} reported by the provider)`
            : ''),
      );
    } finally {
      await db.destroy();
    }
  });

providerModels
  .command('add')
  .description("register a model under a provider (for chatbots' `set-model` to resolve against)")
  .argument('<provider>', 'provider name (from `sw provider list`)')
  .argument(
    '<model-slug>',
    'model identifier as the provider reports it, e.g. anthropic/claude-haiku-4.5',
  )
  .requiredOption('-c, --context-window <n>', 'total context tokens for this model', (raw) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`--context-window must be a positive integer (got "${raw}")`);
    }
    return n;
  })
  .option(
    '--input-price <usd_per_million>',
    'input token price, USD per million tokens',
    parseFloat,
  )
  .option(
    '--output-price <usd_per_million>',
    'output token price, USD per million tokens',
    parseFloat,
  )
  .action(
    async (
      providerName: string,
      modelSlug: string,
      opts: { contextWindow: number; inputPrice?: number; outputPrice?: number },
    ) => {
      try {
        const provider = await getProviderByName(db, providerName);
        if (!provider) {
          console.error(
            `Provider not found: name="${providerName}". Register it with \`sw provider add\`.`,
          );
          process.exitCode = 1;
          return;
        }
        const row = await createProviderModel(db, {
          provider_id: provider.id,
          model_slug: modelSlug,
          context_window: opts.contextWindow,
          input_per_million_usd: opts.inputPrice ?? null,
          output_per_million_usd: opts.outputPrice ?? null,
        });
        console.log(
          `Added model: ${provider.name}/${row.model_slug} context_window=${row.context_window} ` +
            `input=${row.input_per_million_usd ?? '(unmetered)'} ` +
            `output=${row.output_per_million_usd ?? '(unmetered)'}`,
        );
      } finally {
        await db.destroy();
      }
    },
  );

providerModels
  .command('list')
  .description('list models registered under a provider (DB; full slugs are copy-pasteable)')
  .argument('<provider>', 'provider name')
  .action(async (providerName: string) => {
    try {
      const provider = await getProviderByName(db, providerName);
      if (!provider) {
        console.error(`Provider not found: name="${providerName}"`);
        process.exitCode = 1;
        return;
      }
      const rows = await listProviderModelsForProvider(db, provider.id);
      if (rows.length === 0) {
        console.log(`(no models registered against provider "${providerName}")`);
        return;
      }
      const slugW = Math.max(12, ...rows.map((r) => `${provider.name}/${r.model_slug}`.length));
      console.log(`${'full slug'.padEnd(slugW)}  ${'context'.padEnd(8)}  in $/M   out $/M`);
      for (const r of rows) {
        const full = `${provider.name}/${r.model_slug}`.padEnd(slugW);
        const ctx = String(r.context_window).padEnd(8);
        const inPrice = (r.input_per_million_usd ?? '-').padEnd(8);
        const outPrice = r.output_per_million_usd ?? '-';
        console.log(`${full}  ${ctx}  ${inPrice} ${outPrice}`);
      }
    } finally {
      await db.destroy();
    }
  });

providerModels
  .command('remove')
  .description('remove a model registered under a provider')
  .argument('<provider>', 'provider name')
  .argument('<model-slug>', 'model identifier (as registered with `add`)')
  .action(async (providerName: string, modelSlug: string) => {
    try {
      await deleteProviderModel(db, providerName, modelSlug);
      console.log(`Removed model: ${providerName}/${modelSlug}`);
    } finally {
      await db.destroy();
    }
  });

// -----------------------------------------------------------------------------
// blocks subgroup
// -----------------------------------------------------------------------------

const blocks = program.command('blocks').description('inspect per-chatbot system blocks');

blocks
  .command('list')
  .argument('<slug>', 'chatbot slug')
  .action(async (slug: string) => {
    try {
      const chatbotRow = await getChatbotBySlug(db, slug);
      if (!chatbotRow) {
        console.error(`Chatbot not found: slug="${slug}"`);
        process.exitCode = 1;
        return;
      }
      const diskBlocks = await loadDiskBlocks(slug);
      const assembled = assemblePrompt({ persona: chatbotRow.persona, diskBlocks });

      const names = Object.keys(assembled.perBlockTokens);
      if (names.length === 0) {
        console.log(`No blocks for slug="${slug}" (persona NULL, no .md files on disk).`);
      } else {
        console.log(`Blocks for slug="${slug}":`);
        for (const name of names) {
          console.log(`  ${name.padEnd(20)}  ~${assembled.perBlockTokens[name]} tokens`);
        }
      }
      console.log(
        `Total estimated tokens (including handling rule): ~${assembled.estimatedTokens}`,
      );
    } finally {
      await db.destroy();
    }
  });

// -----------------------------------------------------------------------------
// sessions subgroup
// -----------------------------------------------------------------------------

const sessions = program
  .command('sessions')
  .description('read-only browse over sessions (dev/admin view; M13 brings a richer surface)');

sessions
  .command('list')
  .option('-c, --chatbot <slug>', 'filter to a single chatbot')
  .option('-n, --limit <n>', 'maximum rows to return (default 20, max 200)')
  .action(async (opts: { chatbot?: string; limit?: string }) => {
    try {
      const limit = opts.limit ? Number(opts.limit) : undefined;
      const rows = await listSessions(db, { chatbotSlug: opts.chatbot, limit });
      if (rows.length === 0) {
        console.log('(no sessions match)');
        return;
      }
      const slugW = Math.max(7, ...rows.map((r) => r.chatbot_slug.length));
      const idW = Math.max(2, ...rows.map((r) => String(r.id).length));
      console.log(
        `${'id'.padStart(idW)}  ${'chatbot'.padEnd(slugW)}  token (prefix)     msgs  last_active`,
      );
      for (const r of rows) {
        const tokenPrefix = r.token.slice(0, 16) + '…';
        const lastActive =
          r.last_active_at instanceof Date
            ? r.last_active_at.toISOString()
            : String(r.last_active_at);
        console.log(
          `${String(r.id).padStart(idW)}  ${r.chatbot_slug.padEnd(slugW)}  ${tokenPrefix}  ` +
            `${String(r.message_count).padStart(4)}  ${lastActive}`,
        );
      }
    } finally {
      await db.destroy();
    }
  });

sessions
  .command('show')
  .argument('<token-or-id>', 'numeric session id, or the full session token')
  .action(async (ref: string) => {
    try {
      const session = await findSessionByTokenOrId(db, ref);
      if (!session) {
        console.error(`Session not found: ref="${ref}"`);
        process.exitCode = 1;
        return;
      }
      const chatbotRow = await getChatbotBySlug(
        db,
        // session has chatbot_id only; fetch slug for display.
        (await db('chatbots').where({ id: session.chatbot_id }).first('slug'))?.slug as string,
      );
      const messages = await listMessages(db, session.id);
      console.log(`Session ${session.id} (chatbot "${chatbotRow?.slug ?? '?'}"):`);
      console.log(`  token:          ${session.token}`);
      console.log(`  created_at:     ${session.created_at.toISOString()}`);
      console.log(`  last_active_at: ${session.last_active_at.toISOString()}`);
      console.log(`  summary:        ${session.summary ?? '(none)'}`);
      console.log(`  messages:       ${messages.length}`);
      if (messages.length === 0) return;
      console.log('');
      console.log('Messages:');
      for (const m of messages) {
        const ts = m.created_at.toISOString();
        const head = `  [${m.id}] ${ts} ${m.role}:`;
        // First line gets the header; subsequent lines are indented to align.
        const lines = m.content.split('\n');
        console.log(`${head} ${lines[0]}`);
        for (const line of lines.slice(1)) {
          console.log(`    ${line}`);
        }
      }
    } finally {
      await db.destroy();
    }
  });

await program.parseAsync();
