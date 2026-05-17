import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { db } from '../db/index.js';
import { env } from '../config/env.js';
import { getWebsiteBySlug } from '../services/websites.js';

interface ChatOpts {
  origin?: string;
  host?: string;
  port?: string;
}

interface SessionResponse {
  session_token: string;
  welcome_message: string;
}

interface ChatErrorBody {
  error: string;
  detail?: Record<string, unknown>;
}

interface ChatSuccess {
  reply: string;
  message_id: number;
}

async function firstOriginForSlug(slug: string): Promise<string | null> {
  const row = await db('website_origins')
    .join('websites', 'websites.id', 'website_origins.website_id')
    .where('websites.slug', slug)
    .orderBy('website_origins.id', 'asc')
    .first('website_origins.origin');
  return row ? (row.origin as string) : null;
}

async function postJSON<T>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ ok: boolean; status: number; data: T | ChatErrorBody }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = { error: `non_json_response_${res.status}` };
  }
  return { ok: res.ok, status: res.status, data: data as T | ChatErrorBody };
}

async function run(slug: string, opts: ChatOpts): Promise<void> {
  const host = opts.host ?? env.http.host;
  const port = opts.port ? Number(opts.port) : env.http.port;
  const baseUrl = `http://${host}:${port}`;

  let origin = opts.origin;
  if (!origin) {
    const website = await getWebsiteBySlug(db, slug);
    if (!website) {
      console.error(`Website not found: slug="${slug}"`);
      process.exitCode = 1;
      return;
    }
    const looked = await firstOriginForSlug(slug);
    if (!looked) {
      console.error(
        `No origins configured for "${slug}". Add one with: ./bin/sw website origins add ${slug} <https://example.com>`,
      );
      process.exitCode = 1;
      return;
    }
    origin = looked;
  }

  console.error(`connecting to ${baseUrl} as origin ${origin} (slug=${slug})`);

  const sessionRes = await postJSON<SessionResponse>(`${baseUrl}/sessions`, {}, { origin });
  if (!sessionRes.ok) {
    const err = sessionRes.data as ChatErrorBody;
    console.error(`POST /sessions failed (${sessionRes.status}): ${err.error}`);
    process.exitCode = 1;
    return;
  }
  const { session_token, welcome_message } = sessionRes.data as SessionResponse;
  console.log(welcome_message);

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    while (true) {
      const line = await rl.question('> ').catch(() => null);
      if (line === null) break;
      const text = line.trim();
      if (text.length === 0) continue;
      if (text === '/quit' || text === '/exit') break;

      const chatRes = await postJSON<ChatSuccess>(
        `${baseUrl}/chat`,
        { message: text },
        { authorization: `Bearer ${session_token}` },
      );
      if (!chatRes.ok) {
        const err = chatRes.data as ChatErrorBody;
        const detail = err.detail ? ' ' + JSON.stringify(err.detail) : '';
        console.error(`! ${chatRes.status} ${err.error}${detail}`);
        continue;
      }
      const success = chatRes.data as ChatSuccess;
      console.log(success.reply);
    }
  } finally {
    rl.close();
  }
}

const program = new Command();
program
  .name('chat')
  .description('interactive test client for site-walker (POST /sessions + POST /chat)')
  .argument('<slug>', 'website slug to chat against')
  .option(
    '--origin <url>',
    'Origin header to send (defaults to first allowlisted origin for the slug)',
  )
  .option('--host <host>', 'API host (defaults to $HOST or 127.0.0.1)')
  .option('--port <port>', 'API port (defaults to $PORT or 47830)')
  .action(async (slug: string, opts: ChatOpts) => {
    try {
      await run(slug, opts);
    } finally {
      await db.destroy();
    }
  });

await program.parseAsync(process.argv);
