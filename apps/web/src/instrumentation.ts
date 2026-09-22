export async function register(): Promise<void> {
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
