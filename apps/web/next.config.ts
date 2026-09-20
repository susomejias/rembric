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
  // Output tracing follows static imports only, so it misses the files each
  // runtime loader opens by computed path. Every glob is resolved from the app
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
      // `onnxruntime-node` finds its addon through a computed `require`
      // (`../bin/napi-v6/${process.platform}/${process.arch}/…`), which tracing
      // *does* follow — it specialises both expressions — so the binding `.node`
      // lands on its own. What `dlopen` loads next is invisible to tracing:
      // measured on the assembled standalone tree, requiring the package fails
      // with `Library not loaded: @rpath/libonnxruntime.1.24.3.dylib`, and the
      // addon's only `LC_RPATH` is `@loader_path`, so the library has to sit in
      // the binding's own directory for the binding to load at all.
      //
      // The platform/arch pair is interpolated rather than wildcarded because
      // it is the same expression the loader computes, which is what makes the
      // target unambiguous at build time. `bin/napi-v6/**` would instead carry
      // the 175 MB of win32/darwin prebuilts this process can never load
      // (measured: 210 MB for every pair, 35 MB for this one).
      `../../node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v6/${process.platform}/${process.arch}/**`,
    ],
  },
};

export default nextConfig;
