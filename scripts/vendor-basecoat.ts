// Copies Basecoat's prebuilt stylesheet and license from the pinned
// devDependency into src/assets, where the server serves them from its own
// origin. Run after changing the basecoat-css version:
//   npx tsx scripts/vendor-basecoat.ts
// The test suite checks that the vendored copy matches the package.
import { copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = dirname(require.resolve('basecoat-css/package.json'));
copyFileSync(join(root, 'dist/basecoat.cdn.min.css'), 'src/assets/basecoat.css');
copyFileSync(join(root, 'LICENSE.md'), 'src/assets/Basecoat-LICENSE.md');
