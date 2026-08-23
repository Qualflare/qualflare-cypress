import { createRequire } from 'node:module';

import { defineConfig } from 'tsup';

// tsup.config.ts itself is executed directly by tsup's own Node process
// (never bundled), so a plain require() here is safe — this is NOT the
// same runtime context as the package's own dual CJS/ESM output, which
// must not rely on import.meta.url (see src/plugin/version.ts).
const require = createRequire(import.meta.url);
const pkg = require('./package.json') as { version: string };

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'plugin/index': 'src/plugin/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node18',
  splitting: false,
  shims: false,
  define: {
    __PACKAGE_VERSION__: JSON.stringify(pkg.version),
  },
});
