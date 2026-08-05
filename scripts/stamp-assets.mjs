/* Fingerprints every local asset with a hash of its contents:
 *
 *   game.html   ->  ./src/main.js?v=9d6e3e77
 *   main.js     ->  import … from './render/ocean.js?v=a1b2c3d4'
 *
 * There is no build step, so nothing else does this. Two separate hazards:
 *
 *  1. A hand-written ?v= token on the HTML means shipping a fix without editing
 *     it by hand leaves returning browsers executing the previous file.
 *  2. Stamping only the HTML is not enough. Modules imported *by* those entry
 *     points carry no token at all, so a browser holding an old copy of
 *     src/render/ocean.js keeps running it even after main.js is refetched.
 *     That is a fix that appears to deploy and simply does not arrive.
 *
 * So hashes propagate through the import graph, computed leaf-first: rewriting a
 * module's imports changes its bytes, which changes its own hash, which changes
 * how its importers refer to it.
 *
 *   npm run stamp
 *
 * Safe to run always; with no source changes it is a no-op.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, join, relative } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PAGES = ['index.html', 'game.html'];

const hash = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 8);

/* src="./x.js?v=…" / href="./x.css?v=…" in HTML. */
const HTML_ASSET = /((?:src|href)=")(\.\/[^"?]+\.(?:js|css))(\?[^"]*)?(")/g;
/* from './x.js?v=…' / import('./x.js') in JS — relative specifiers only. */
const JS_IMPORT = /((?:from|import)\s*\(?\s*['"])(\.\.?\/[^'"?]+\.js)(\?[^'"]*)?(['"])/g;

const finalHash = new Map();   // abs path -> hash of its final contents
const finalText = new Map();   // abs path -> final contents
const visiting = new Set();

/* Post-order: a module's hash depends on its rewritten imports, so every
 * dependency has to be resolved before the importer can be hashed. */
async function resolveModule(absPath) {
    if (finalHash.has(absPath)) return finalHash.get(absPath);
    if (visiting.has(absPath)) {
        /* An import cycle has no leaf-first order. Hash the raw bytes and move
         * on — it is still content-derived, just not dependency-aware. */
        return hash(await readFile(absPath));
    }
    visiting.add(absPath);

    let text = await readFile(absPath, 'utf8');
    const edits = [];

    for (const m of text.matchAll(JS_IMPORT)) {
        const depPath = join(dirname(absPath), m[2]);
        let depHash;
        try { depHash = await resolveModule(depPath); }
        catch { continue; }                       // not a local file we manage
        edits.push([m[0], `${m[1]}${m[2]}?v=${depHash}${m[4]}`]);
    }
    for (const [from, to] of edits) text = text.replace(from, to);

    visiting.delete(absPath);
    finalText.set(absPath, text);
    const h = hash(Buffer.from(text, 'utf8'));
    finalHash.set(absPath, h);
    return h;
}

/* Walk the graph from each page's entry scripts. */
for (const page of PAGES) {
    const pagePath = join(ROOT, page);
    const html = await readFile(pagePath, 'utf8');
    for (const m of html.matchAll(HTML_ASSET)) {
        if (!m[2].endsWith('.js')) continue;
        try { await resolveModule(join(dirname(pagePath), m[2])); } catch {}
    }
}

/* Write rewritten modules. */
let moduleWrites = 0;
for (const [absPath, text] of finalText) {
    const current = await readFile(absPath, 'utf8');
    if (current !== text) {
        await writeFile(absPath, text);
        moduleWrites++;
        console.log(`  ${relative(ROOT, absPath)}: imports restamped`);
    }
}

/* Then the HTML, using the final hashes. */
let pageWrites = 0;
for (const page of PAGES) {
    const pagePath = join(ROOT, page);
    const html = await readFile(pagePath, 'utf8');
    const edits = [];

    for (const m of html.matchAll(HTML_ASSET)) {
        const assetPath = join(dirname(pagePath), m[2]);
        let h = finalHash.get(assetPath);
        if (!h) {
            try { h = hash(await readFile(assetPath)); }
            catch { console.warn(`  ! ${page}: ${m[2]} not found, leaving as-is`); continue; }
        }
        edits.push([m[0], `${m[1]}${m[2]}?v=${h}${m[4]}`]);
    }

    let next = html;
    for (const [from, to] of edits) next = next.replace(from, to);
    if (next !== html) {
        await writeFile(pagePath, next);
        pageWrites++;
        console.log(`  ${page}: ${edits.length} asset(s) stamped`);
    }
}

console.log(
    moduleWrites || pageWrites
        ? `stamped ${finalHash.size} module(s) across ${PAGES.length} page(s)`
        : 'already current',
);
