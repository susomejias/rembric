/**
 * Server entrypoints. `createServer` is for library embedding; `startCli`
 * is what `npx rembric` calls and wires signal handling for clean shutdown.
 */

import { bootstrap, type BootstrappedServer } from './bootstrap.js';

export async function createServer(
  env: NodeJS.ProcessEnv = process.env,
): Promise<BootstrappedServer> {
  return bootstrap(env);
}

export async function startCli(): Promise<void> {
  const server = await bootstrap();

  const shutdownOnce = once(async (signal: string) => {
    console.error(`\n  received ${signal}, shutting down…`);
    try {
      await server.shutdown();
      console.error('  ✓ stopped cleanly');
      process.exit(0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ shutdown error: ${message}`);
      process.exit(1);
    }
  });

  process.on('SIGINT', () => void shutdownOnce('SIGINT'));
  process.on('SIGTERM', () => void shutdownOnce('SIGTERM'));
  process.on('uncaughtException', (err) => {
    console.error('uncaughtException:', err);
    void shutdownOnce('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    console.error('unhandledRejection:', reason);
    void shutdownOnce('unhandledRejection');
  });
}

function once<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  let fired = false;
  return (...args: A) => {
    if (fired) return Promise.resolve();
    fired = true;
    return fn(...args);
  };
}
