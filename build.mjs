// Bundles each entry point into a self-contained ESM file under plugin/scripts,
// so the installed plugin needs no `npm install`.
import { build } from 'esbuild';

const entries = {
  hook: 'src/hooks/hook.ts',
  worker: 'src/worker/main.ts',
  mcp: 'src/mcp/server.ts',
  cli: 'src/cli/index.ts',
};

await Promise.all(
  Object.entries(entries).map(([name, entry]) =>
    build({
      entryPoints: [entry],
      outfile: `plugin/scripts/${name}.mjs`,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      // CJS deps bundled into ESM need a real `require`.
      banner: {
        js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
      },
      logLevel: 'warning',
    }),
  ),
);
console.log('built:', Object.keys(entries).map((n) => `plugin/scripts/${n}.mjs`).join(', '));
