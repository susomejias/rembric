/**
 * Public entry point for embedding the rembric programmatically.
 *
 * In v0 the canonical surface is the CLI (`rembric`). This file is
 * kept thin and exports the createServer factory so future consumers can
 * embed the server inside another Node process if they want.
 */

export { createServer } from './server/index.js';
export { loadConfig } from './config.js';
export type { Config } from './config.js';
