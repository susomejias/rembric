#!/usr/bin/env node

import { runBridge } from './bridge.mjs';

if (process.argv.length === 2) {
  process.exitCode = await runBridge();
} else {
  process.stderr.write('[rembric-bridge] This executable accepts no command-line arguments.\n');
  process.exitCode = 1;
}
