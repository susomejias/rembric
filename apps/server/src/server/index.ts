/**
 * Server entrypoints. `createServer` is the internal test-harness factory
 * (used by the E2E tests in src/test/ to spin a server with an injected env);
 * `startCli` is what `src/server-entrypoint.ts` invokes and wires signal
 * handling for clean shutdown.
 */

import { bootstrap, type BootstrappedServer, type BootstrapOverrides } from './bootstrap.js';

export type { BootstrappedServer, BootstrapOverrides };

export async function createServer(
  env: NodeJS.ProcessEnv = process.env,
  overrides: BootstrapOverrides = {},
): Promise<BootstrappedServer> {
  return bootstrap(env, overrides);
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
