import { Command } from 'commander';
import { assertEnvFilePermissions } from '../utils/env.js';
import { db } from '../db/index.js';

assertEnvFilePermissions();
import {
  addOrigin,
  createWebsite,
  deleteWebsite,
  getWebsiteBySlug,
  listOrigins,
  listWebsites,
  removeOrigin,
  setPersona,
  setWelcomeMessage,
} from '../services/websites.js';
import { findSessionByTokenOrId, listMessages, listSessions } from '../services/sessions.js';
import { assemblePrompt, loadDiskBlocks } from '../services/system-blocks.js';
import { resolveModel, setContextWindow, setModel, setParameters } from '../services/models.js';
import { loadConfig } from '../config/site-walker-config.js';
import { listProviderModels } from '../providers/list-models.js';
import { readPersonaTemplate } from '../utils/templates.js';

const program = new Command();

program.name('sw').description('site-walker admin CLI').version('0.9.1');

const website = program.command('website').description('manage websites');

website
  .command('create')
  .argument('<slug>', 'URL-safe slug, e.g. acme-corp')
  .option('-n, --name <name>', 'human-readable name (defaults to slug)')
  .action(async (slug: string, opts: { name?: string }) => {
    try {
      const persona = await readPersonaTemplate();
      const row = await createWebsite(db, { slug, name: opts.name ?? slug, persona });
      console.log(`Created website: id=${row.id} slug=${row.slug} name="${row.name}"`);
      console.log(`Persona seeded from templates/PERSONA.md (${persona.length} chars).`);
    } finally {
      await db.destroy();
    }
  });

website
  .command('list')
  .description('list all websites (slug, name, model, origin count)')
  .action(async () => {
    try {
      const rows = await listWebsites(db);
      if (rows.length === 0) {
        console.log('(no websites)');
        return;
      }
      const counts = await db('website_origins')
        .select('website_id')
        .count<{ website_id: number; n: string | number }[]>({ n: '*' })
        .groupBy('website_id');
      const countByWebsiteId = new Map<number, number>(
        counts.map((r) => [r.website_id, Number(r.n)]),
      );
      const slugW = Math.max(4, ...rows.map((r) => r.slug.length));
      const nameW = Math.max(4, ...rows.map((r) => r.name.length));
      console.log(
        `${'slug'.padEnd(slugW)}  ${'name'.padEnd(nameW)}  ${'model'.padEnd(28)}  origins`,
      );
      for (const r of rows) {
        const model = r.model_slug ?? '(unset)';
        const origins = countByWebsiteId.get(r.id) ?? 0;
        console.log(
          `${r.slug.padEnd(slugW)}  ${r.name.padEnd(nameW)}  ${model.padEnd(28)}  ${origins}`,
        );
      }
    } finally {
      await db.destroy();
    }
  });

website
  .command('show')
  .argument('<slug>', 'website slug')
  .action(async (slug: string) => {
    try {
      const row = await getWebsiteBySlug(db, slug);
      if (!row) {
        console.error(`Website not found: slug="${slug}"`);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(row, null, 2));
    } finally {
      await db.destroy();
    }
  });

website
  .command('add-origin')
  .description('alias for `sw website origins add <slug> <origin>`')
  .argument('<slug>', 'website slug')
  .argument('<origin>', 'origin URL (scheme + host only, e.g. https://example.com)')
  .action(async (slug: string, origin: string) => {
    try {
      const row = await addOrigin(db, slug, origin);
      console.log(`Added origin id=${row.id} origin="${row.origin}" to website slug="${slug}"`);
    } finally {
      await db.destroy();
    }
  });

website
  .command('delete')
  .description('delete a website and everything that references it (cascade)')
  .argument('<slug>', 'website slug')
  .option('-f, --force', 'required — irreversible, deletes origins/sessions/messages too')
  .action(async (slug: string, opts: { force?: boolean }) => {
    try {
      if (!opts.force) {
        console.error(
          `Refusing to delete website "${slug}" without --force.\n` +
            `Pass -f|--force to confirm. This cascades to origins, sessions, and messages.`,
        );
        process.exitCode = 1;
        return;
      }
      const counts = await deleteWebsite(db, slug);
      console.log(
        `Deleted website slug="${slug}". Cascaded: ${counts.origins} origin(s), ` +
          `${counts.sessions} session(s), ${counts.messages} message(s).`,
      );
    } finally {
      await db.destroy();
    }
  });

website
  .command('set-welcome')
  .description(
    'set the welcome message returned by POST /sessions (empty string clears to default)',
  )
  .argument('<slug>', 'website slug')
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

const origins = website
  .command('origins')
  .description("manage a website's origin allowlist (list/add/remove)");

origins
  .command('list')
  .argument('<slug>', 'website slug')
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
  .argument('<slug>', 'website slug')
  .argument('<origin>', 'origin URL (scheme + host only, e.g. https://example.com)')
  .action(async (slug: string, origin: string) => {
    try {
      const row = await addOrigin(db, slug, origin);
      console.log(`Added origin id=${row.id} origin="${row.origin}" to website slug="${slug}"`);
    } finally {
      await db.destroy();
    }
  });

origins
  .command('remove')
  .argument('<slug>', 'website slug')
  .argument('<origin-or-id>', 'origin URL or numeric website_origins.id')
  .action(async (slug: string, ref: string) => {
    try {
      const row = await removeOrigin(db, slug, ref);
      console.log(`Removed origin id=${row.id} origin="${row.origin}" from slug="${slug}"`);
    } finally {
      await db.destroy();
    }
  });

website
  .command('set-persona')
  .argument('<slug>', 'website slug')
  .argument('<persona-text>', 'persona text to store on the website')
  .action(async (slug: string, personaText: string) => {
    try {
      const row = await setPersona(db, slug, personaText);
      console.log(`Updated persona for slug="${row.slug}" (${personaText.length} chars).`);
    } finally {
      await db.destroy();
    }
  });

website
  .command('set-model')
  .argument('<slug>', 'website slug')
  .argument('<model-slug>', 'provider/model, e.g. pi/qwen2:1.5b')
  .action(async (slug: string, modelSlug: string) => {
    try {
      const registry = await loadConfig();
      const row = await setModel(db, slug, modelSlug, registry);
      console.log(`Set model_slug="${row.model_slug}" for website slug="${row.slug}".`);
    } finally {
      await db.destroy();
    }
  });

website
  .command('set-parameters')
  .argument('<slug>', 'website slug')
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
        `Set model_parameters for website slug="${row.slug}": ${JSON.stringify(row.model_parameters)}`,
      );
    } finally {
      await db.destroy();
    }
  });

website
  .command('set-context-window')
  .argument('<slug>', 'website slug')
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

website
  .command('show-model')
  .argument('<slug>', 'website slug')
  .action(async (slug: string) => {
    try {
      const row = await getWebsiteBySlug(db, slug);
      if (!row) {
        console.error(`Website not found: slug="${slug}"`);
        process.exitCode = 1;
        return;
      }
      if (!row.model_slug) {
        console.log(`Website "${slug}" has no model_slug set.`);
        return;
      }
      const registry = await loadConfig();
      const resolved = resolveModel(row, registry);
      console.log(`Website: ${resolved.websiteSlug}`);
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

const blocks = program.command('blocks').description('inspect per-website system blocks');

blocks
  .command('list')
  .argument('<slug>', 'website slug')
  .action(async (slug: string) => {
    try {
      const website = await getWebsiteBySlug(db, slug);
      if (!website) {
        console.error(`Website not found: slug="${slug}"`);
        process.exitCode = 1;
        return;
      }
      const diskBlocks = await loadDiskBlocks(slug);
      const assembled = assemblePrompt({ persona: website.persona, diskBlocks });

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

const sessions = program
  .command('sessions')
  .description('read-only browse over sessions (dev/admin view; M13 brings a richer surface)');

sessions
  .command('list')
  .option('-w, --website <slug>', 'filter to a single website')
  .option('-n, --limit <n>', 'maximum rows to return (default 20, max 200)')
  .action(async (opts: { website?: string; limit?: string }) => {
    try {
      const limit = opts.limit ? Number(opts.limit) : undefined;
      const rows = await listSessions(db, { websiteSlug: opts.website, limit });
      if (rows.length === 0) {
        console.log('(no sessions match)');
        return;
      }
      const slugW = Math.max(7, ...rows.map((r) => r.website_slug.length));
      const idW = Math.max(2, ...rows.map((r) => String(r.id).length));
      console.log(
        `${'id'.padStart(idW)}  ${'website'.padEnd(slugW)}  token (prefix)     msgs  last_active`,
      );
      for (const r of rows) {
        const tokenPrefix = r.token.slice(0, 16) + '…';
        const lastActive =
          r.last_active_at instanceof Date
            ? r.last_active_at.toISOString()
            : String(r.last_active_at);
        console.log(
          `${String(r.id).padStart(idW)}  ${r.website_slug.padEnd(slugW)}  ${tokenPrefix}  ` +
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
      const website = await getWebsiteBySlug(
        db,
        // session has website_id only; fetch slug for display.
        (await db('websites').where({ id: session.website_id }).first('slug'))?.slug as string,
      );
      const messages = await listMessages(db, session.id);
      console.log(`Session ${session.id} (website "${website?.slug ?? '?'}"):`);
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
