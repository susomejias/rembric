import { join } from 'node:path';

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // Next traces module dependencies starting at the app directory, so in a
  // monorepo everything outside `apps/web` — `packages/*`, `/models` — is
  // silently absent from `.next/standalone`. Measured requirement: point the
  // trace at the repo root, not the project directory.
  outputFileTracingRoot: join(import.meta.dirname, '../..'),
  // Prebuilt native bindings cannot be bundled: better-sqlite3 and sqlite-vec
  // are the .node addons `@rembric/db` loads, and onnxruntime-node is what
  // `@huggingface/transformers` (via `@rembric/core`) runs the embedder on.
  serverExternalPackages: ['better-sqlite3', 'sqlite-vec', 'onnxruntime-node'],
  // Output tracing follows static imports only, so it misses the two files the
  // DB opens by computed path at runtime. Both globs are resolved from the app
  // directory, which is why the workspace root needs the `../../` prefix:
  // `apps/web/node_modules` has no `.pnpm` in it.
  outputFileTracingIncludes: {
    '/*': [
      // `sqlite-vec` picks its native extension at runtime with an
      // `import.meta.resolve('sqlite-vec-<platform>-<arch>/vec0.<ext>')`. pnpm
      // links that optional dependency inside the package's own virtual-store
      // directory, which is one of the places Node probes when resolving from
      // `.../sqlite-vec@<v>/node_modules/sqlite-vec/`. Copying the files there
      // (the glob resolves through the link, so the copy is a real directory)
      // is what makes the import succeed on every platform the store holds.
      '../../node_modules/.pnpm/sqlite-vec@*/node_modules/sqlite-vec-*/**',
      // `defaultMigrationsDir()` resolves off `import.meta.url`, which Turbopack
      // rewrites to the module's project-root-relative path, so the runner reads
      // `<projectRoot>/packages/db/dist/migrations` — absent from the standalone
      // copy until this include puts it there. The runner only ever
      // `readdirSync`es the directory, so the flat `*.sql` is its own contract.
      '../../packages/db/dist/migrations/*.sql',
    ],
  },
};

export default nextConfig;
