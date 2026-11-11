// Copies third-party assets from their exactly pinned devDependencies into
// src/assets, where the server serves them from its own origin (the CSP
// allows no other). Run after changing one of these package versions:
//   npx tsx scripts/vendor-assets.ts
// The test suite checks that every vendored copy matches its package.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
// Some packages (simple-icons) don't export package.json; their entry file sits at the root.
const packageRoot = (name: string) => {
  try { return dirname(require.resolve(`${name}/package.json`)); } catch { return dirname(require.resolve(name)); }
};

/** [package, file inside the package, destination in src/assets] */
export const vendored: [string, string, string][] = [
  ['basecoat-css', 'dist/basecoat.cdn.min.css', 'basecoat.css'],
  ['basecoat-css', 'LICENSE.md', 'Basecoat-LICENSE.md'],
  ['@fontsource-variable/bricolage-grotesque', 'files/bricolage-grotesque-latin-opsz-normal.woff2', 'bricolage-grotesque.woff2'],
  ['@fontsource-variable/bricolage-grotesque', 'LICENSE', 'BricolageGrotesque-LICENSE.txt'],
  ['@fontsource-variable/instrument-sans', 'files/instrument-sans-latin-wght-normal.woff2', 'instrument-sans.woff2'],
  ['@fontsource-variable/instrument-sans', 'LICENSE', 'InstrumentSans-LICENSE.txt'],
  // Assistant logos for the landing page (CC0 paths; the marks belong to their owners).
  ['simple-icons', 'icons/claudecode.svg', 'logos/claudecode.svg'],
  ['simple-icons', 'icons/opencode.svg', 'logos/opencode.svg'],
  ['simple-icons', 'icons/googlegemini.svg', 'logos/googlegemini.svg'],
  ['simple-icons', 'LICENSE.md', 'logos/SimpleIcons-LICENSE.md'],
];

export const vendoredSource = (name: string, file: string) => join(packageRoot(name), file);

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync('src/assets/logos', { recursive: true });
  for (const [name, file, destination] of vendored) copyFileSync(vendoredSource(name, file), join('src/assets', destination));
}
