// node build.mjs → docs/index.html (single file, everything inlined)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');
const optional = (p) => (existsSync(join(root, p)) ? read(p) : null);
// Keep inlined JS from closing its own <script> tag.
const safeJs = (js) => js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
// Replacement functions avoid `$&`-style patterns in the inlined text being interpreted.
const inject = (html, marker, text) => {
  if (!html.includes(marker)) throw new Error(`index.html is missing ${marker}`);
  return html.replace(marker, () => text);
};

const scripts = [
  ['src/core.js', true],
  ['src/analytics.js', true],
  ['src/sample-data.js', false],
  ['dist/platform.js', false],
  ['src/app.js', true],
];
const js = scripts
  .map(([p, required]) => {
    const code = required ? read(p) : optional(p);
    return code == null ? '' : `<script>\n/* ${p} */\n${safeJs(code)}\n</script>`;
  })
  .filter(Boolean)
  .join('\n');

let html = read('src/index.html');
html = inject(html, '<!-- STYLES -->', `<style>\n${read('src/styles.css')}\n</style>`);
html = inject(html, '<!-- SCRIPTS -->', js);

const out = join(root, 'docs/index.html');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`docs/index.html  ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB`);
