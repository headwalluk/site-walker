import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { assertEnvFilePermissions } from '../utils/env.js';

assertEnvFilePermissions();

const rl = createInterface({ input, output });

console.log('site-walker chat — type "exit" or Ctrl-D to quit.');
console.log('(not wired to the API yet — placeholder for M6)');
console.log();

try {
  while (true) {
    const line = (await rl.question('> ')).trim();
    if (line === 'exit') break;
    if (!line) continue;
    console.log(`(echo) ${line}`);
  }
} finally {
  rl.close();
}
