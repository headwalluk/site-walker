import { Command } from 'commander';
import { assertEnvFilePermissions } from '../utils/env.js';
import { db } from '../db/index.js';

assertEnvFilePermissions();
import {
  addOrigin,
  createWebsite,
  getWebsiteBySlug,
  listWebsites,
  setPersona,
} from '../services/websites.js';
import { assemblePrompt, loadDiskBlocks } from '../services/system-blocks.js';
import { resolveModel, setContextWindow, setModel, setParameters } from '../services/models.js';
import { loadConfig } from '../config/site-walker-config.js';
import { readPersonaTemplate } from '../utils/templates.js';

const program = new Command();

program.name('sw').description('site-walker admin CLI').version('0.6.0');

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

await program.parseAsync();
