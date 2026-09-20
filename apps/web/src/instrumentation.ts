/**
 * Next's once-per-server-instance bootstrap hook — the replacement for
 * `apps/server/src/server/bootstrap.ts`'s process responsibilities.
 *
 * Next guarantees the build phase never reaches this hook (`register()` is
 * skipped when `NEXT_PHASE === 'phase-production-build'`, in
 * `next/dist/server/lib/router-utils/instrumentation-globals.external.js`), so
 * the boot below can open the database eagerly without any build-time guard.
 *
 * `register()` must not throw: Next wraps a throwing hook into a fatal boot
 * error. `lib/process.ts` owns per-timer error handling; this file adds the
 * last-resort catch so a failed boot leaves a serving process and a loud line
 * rather than a server that never starts.
 */
export async function register(): Promise<void> {
  // Next calls this hook in every runtime, and everything below is Node-only
  // (better-sqlite3, sqlite-vec, onnxruntime, node:crypto). The import is
  // inside the branch on purpose: a static one would pull Node modules into the
  // Edge compilation.
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;

  try {
    const { startProcess } = await import('./lib/process');
    startProcess();
  } catch (err) {
    console.error(
      '[process] boot failed; the server starts without its process-level work',
      err instanceof Error ? err.message : String(err),
    );
  }
}
