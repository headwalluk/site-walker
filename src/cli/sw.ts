import { Command } from 'commander';

const program = new Command();

program.name('sw').description('site-walker admin CLI').version('0.2.0');

program.parse();
