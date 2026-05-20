#!/usr/bin/env node

import { startCli } from './server/index.js';

startCli().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`rembric: ${message}`);
  process.exit(1);
});
