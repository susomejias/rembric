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
};

export default nextConfig;
