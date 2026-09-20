import { getDb } from '../../lib/db';
import { REMBRIC_VERSION } from '../../lib/version';

// A health probe must read the live process; a cached response would report a
// stale success forever.
export const dynamic = 'force-dynamic';

export function GET(): Response {
  // Fails loudly if better-sqlite3's native binding did not load or the file
  // could not be opened — the SELECT never reaches a statement otherwise.
  getDb().raw.prepare('SELECT 1').get();

  return Response.json({ ok: true, version: REMBRIC_VERSION });
}
