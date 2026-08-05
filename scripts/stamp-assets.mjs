/* Stamps every local script/stylesheet URL in the HTML with a hash of that
 * file's contents:  ./src/main.js?v=a1b2c3d4
 *
 * There is no build step, so nothing else fingerprints these assets. The
 * cache-buster used to be a hand-written string ("?v=importmap-boot-20260805-1")
 * which meant shipping a fix without editing it by hand left every returning
 * browser executing the previous, broken file — the URL had not changed, so the
 * cache was right to keep serving what it had.
 *
 *   npm run stamp
 *
 * Run it after touching anything under src/. Re-running with no source changes
 * is a no-op, so it is safe to run always.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PAGES = ['index.html', 'game.html'];

/* src="./x.js?v=..." and href="./x.css?v=..." — local paths only. */
const ASSET = /((?:src|href)=")(\.\/[^"?]+\.(?:js|css))(\?[^"]*)?(")/g;

let changed = 0;

for (const page of PAGES) {
    const pagePath = join(ROOT, page);
    const html = await readFile(pagePath, 'utf8');
    const replacements = [];

    for (const m of html.matchAll(ASSET)) {
        const assetPath = join(dirname(pagePath), m[2]);
        let contents;
        try { contents = await readFile(assetPath); }
        catch { console.warn(`  ! ${page}: ${m[2]} not found, leaving as-is`); continue; }

        const hash = createHash('sha256').update(contents).digest('hex').slice(0, 8);
        replacements.push([m[0], `${m[1]}${m[2]}?v=${hash}${m[4]}`]);
    }

    let next = html;
    for (const [from, to] of replacements) next = next.replace(from, to);

    if (next !== html) {
        await writeFile(pagePath, next);
        changed++;
        console.log(`  ${page}: ${replacements.length} asset(s) stamped`);
    } else {
        console.log(`  ${page}: already current`);
    }
}

console.log(changed ? 'asset hashes updated' : 'nothing to do');
