#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);
const distCli = join(root, 'dist', 'cli.js');

if (existsSync(distCli)) {
  await import(pathToFileURL(distCli).href);
} else {
  const srcCli = join(root, 'src', 'cli.ts');
  const proc = spawn('npx', ['tsx', srcCli, ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: root,
  });
  proc.on('exit', (code) => process.exit(code ?? 0));
}
