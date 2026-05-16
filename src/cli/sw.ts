import { Command } from 'commander';
import { db } from '../db/index.js';
import { addOrigin, createWebsite, getWebsiteBySlug } from '../services/websites.js';

const program = new Command();

program.name('sw').description('site-walker admin CLI').version('0.2.0');

const website = program.command('website').description('manage websites');

website
  .command('create')
  .argument('<slug>', 'URL-safe slug, e.g. acme-corp')
  .option('-n, --name <name>', 'human-readable name (defaults to slug)')
  .action(async (slug: string, opts: { name?: string }) => {
    try {
      const row = await createWebsite(db, { slug, name: opts.name ?? slug });
      console.log(`Created website: id=${row.id} slug=${row.slug} name="${row.name}"`);
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

await program.parseAsync();
