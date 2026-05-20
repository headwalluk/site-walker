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
import { loadConfig } from '../config/site-walker-config.js';
import { listProviderModels } from '../providers/list-models.js';
import {
  getChatbotGeoSummary,
  setChatbotGeoCountries,
  setChatbotGeoMode,
} from '../services/geo.js';
import { readPersonaTemplate } from '../utils/templates.js';

const program = new Command();

program.name('sw').description('site-walker admin CLI').version('0.11.0');

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
      const registry = await loadConfig();
      const row = await setModel(db, slug, modelSlug, registry);
      console.log(`Set model_slug="${row.model_slug}" for chatbot slug="${row.slug}".`);
    } finally {
      await db.destroy();
    }
  });

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
      const registry = await loadConfig();
      const resolved = resolveModel(row, registry);
      console.log(`Chatbot: ${resolved.chatbotSlug}`);
      console.log(`  model_slug:           ${resolved.modelSlug}`);
      console.log(
        `  provider:             ${resolved.provider.name} (${resolved.provider.protocol})`,
      );
      console.log(`  model:                ${resolved.model}`);
      console.log(`  parameters:           ${JSON.stringify(resolved.parameters)}`);
      console.log(`  model_context_window: ${resolved.contextWindow ?? '(unset)'}`);
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
// provider subgroup
// -----------------------------------------------------------------------------

const provider = program.command('provider').description('inspect the provider registry (TOML)');

provider
  .command('list')
  .description('list providers defined in site-walker.toml (api_keys are never printed)')
  .action(async () => {
    try {
      const registry = await loadConfig();
      console.log(`Provider registry (${registry.configPath}):`);
      if (registry.providers.size === 0) {
        console.log('  (no providers defined)');
        return;
      }
      for (const entry of registry.providers.values()) {
        const baseUrl = entry.base_url ? ` base_url=${entry.base_url}` : '';
        const local = entry.is_local ? ' is_local=true' : '';
        console.log(`  ${entry.name.padEnd(20)} protocol=${entry.protocol}${baseUrl}${local}`);
      }
    } finally {
      await db.destroy();
    }
  });

provider
  .command('models')
  .description('query a provider for its available models (copy-pasteable into `set-model`)')
  .argument('<provider>', 'provider name from site-walker.toml')
  .option('-f, --filter <substring>', 'case-insensitive substring filter against model id + label')
  .action(async (name: string, opts: { filter?: string }) => {
    try {
      const registry = await loadConfig();
      const entry = registry.providers.get(name);
      if (!entry) {
        console.error(
          `Provider "${name}" not defined in ${registry.configPath}. ` +
            `Known: ${[...registry.providers.keys()].join(', ') || '(none)'}.`,
        );
        process.exitCode = 1;
        return;
      }

      const models = await listProviderModels(entry);
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
