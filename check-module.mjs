import { access, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mainModule = new URL('./src/main.js', import.meta.url);
const legacyHtml = new URL('./index.html', import.meta.url);

let checkFile = fileURLToPath(mainModule);

try {
  await access(mainModule);
} catch {
  const html = await readFile(legacyHtml, 'utf8');
  const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);

  if (!match) {
    throw new Error('Could not find src/main.js or inline <script type="module"> block');
  }

  const outFile = join(tmpdir(), 'drone-simulator-inline-module.mjs');
  await writeFile(outFile, match[1], 'utf8');
  checkFile = outFile;
}

const child = spawn(process.execPath, ['--check', checkFile], { stdio: 'inherit' });
const code = await new Promise((resolve) => child.on('close', resolve));

if (code !== 0) {
  process.exit(code ?? 1);
}
