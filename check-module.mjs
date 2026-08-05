/* Static checks that run without a browser.
 *
 *   1. Syntax    — node --check on each module.
 *   2. Bindings  — $-prefixed handles that are used but never declared.
 *   3. Elements  — getElementById lookups with no matching id in the HTML.
 *
 * (2) and (3) exist because both are ReferenceErrors or null derefs that only
 * surface when the page runs, and a module-level one takes the whole simulator
 * down with "failed to start". Deleting a screen is exactly when they happen.
 */
import { access, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mainModule = new URL('./src/main.js', import.meta.url);
const homeModule = new URL('./src/home.js', import.meta.url);
const legacyHtml = new URL('./index.html', import.meta.url);

const checkFiles = [];

try {
  await access(mainModule);
  checkFiles.push(fileURLToPath(mainModule));
} catch {
  const html = await readFile(legacyHtml, 'utf8');
  const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);

  if (!match) {
    throw new Error('Could not find src/main.js or inline <script type="module"> block');
  }

  const outFile = join(tmpdir(), 'drone-simulator-inline-module.mjs');
  await writeFile(outFile, match[1], 'utf8');
  checkFiles.push(outFile);
}

try {
  await access(homeModule);
  checkFiles.push(fileURLToPath(homeModule));
} catch {}

/* ---- 1. syntax ---- */
for (const checkFile of checkFiles) {
  const child = spawn(process.execPath, ['--check', checkFile], { stdio: 'inherit' });
  const code = await new Promise((resolve) => child.on('close', resolve));

  if (code !== 0) {
    process.exit(code ?? 1);
  }
}

const problems = [];

/* ---- 2. undeclared $handles ----
 * Deliberately scanned raw. Trying to strip comments and literals first is what
 * you reach for, but a template literal holding `${a ? {x:1} : 2}` defeats any
 * regex-level stripper and silently eats half the file, which turns this check
 * into one that always passes. Raw text can only produce a false *declaration*
 * (harmless) or flag a name that appears solely in prose (worth knowing). */
for (const file of checkFiles) {
  const code = await readFile(file, 'utf8');

  const declared = new Set();
  for (const m of code.matchAll(/(?:const|let|var|function)\s+(\$[\w$]+)/g)) declared.add(m[1]);
  /* Multi-declarator lines and destructuring: const $a = …, $b = … */
  for (const m of code.matchAll(/[,{([]\s*(\$[\w$]+)\s*[=,;){\]]/g)) declared.add(m[1]);

  const used = new Map();
  for (const m of code.matchAll(/(?<![\w$.'"`])(\$[\w$]+)/g)) {
    if (!used.has(m[1])) used.set(m[1], code.slice(0, m.index).split('\n').length);
  }

  for (const [name, line] of used) {
    if (!declared.has(name)) problems.push(`${file}:${line}  ${name} is used but never declared`);
  }
}

/* ---- 3. getElementById targets ---- */
const pages = [
  ['./game.html', './src/main.js'],
  ['./index.html', './src/home.js'],
];

for (const [pagePath, scriptPath] of pages) {
  let page, script;
  try {
    page = await readFile(new URL(pagePath, import.meta.url), 'utf8');
    script = await readFile(new URL(scriptPath, import.meta.url), 'utf8');
  } catch {
    continue;
  }

  const ids = new Set([...page.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  for (const m of script.matchAll(/getElementById\(['"]([^'"$]+)['"]\)/g)) {
    if (!ids.has(m[1])) {
      const line = script.slice(0, m.index).split('\n').length;
      problems.push(`${scriptPath}:${line}  #${m[1]} not found in ${pagePath}`);
    }
  }
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n` + problems.map((p) => `  ${p}`).join('\n'));
  process.exit(1);
}

console.log(`checked ${checkFiles.length} modules — syntax, $bindings, element ids all clean`);
