import { Command } from 'commander';
import { db } from '../db/index.js';
import { addOrigin, createWebsite, getWebsiteBySlug, setPersona } from '../services/websites.js';
import { assemblePrompt, loadDiskBlocks } from '../services/system-blocks.js';
import { readPersonaTemplate } from '../utils/templates.js';

const program = new Command();

program.name('sw').description('site-walker admin CLI').version('0.3.0');

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
