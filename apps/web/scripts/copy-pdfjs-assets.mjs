/**
 * Copie les ressources runtime de pdf.js dans `public/pdfjs/`.
 *
 * pdf.js ne peut pas peindre une page qui s'appuie sur les 14 polices standard PDF
 * (Helvetica, Times…) sans `standard_fonts/`, ni un document CJK sans `cmaps/` : le
 * rendu reste alors bloqué en attente des fichiers. Comme l'app est auto-hébergée
 * (aucun CDN autorisé), on sert ces fichiers depuis `public/`.
 *
 * Lancé par `predev` / `prebuild` : les fichiers sont dérivés de node_modules, ils
 * n'ont donc pas à être versionnés.
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));
const target = join(process.cwd(), 'public', 'pdfjs');

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const dir of ['standard_fonts', 'cmaps']) {
  await cp(join(pdfjsRoot, dir), join(target, dir), { recursive: true });
}
console.log(`[pdfjs] ressources copiées dans ${target}`);
