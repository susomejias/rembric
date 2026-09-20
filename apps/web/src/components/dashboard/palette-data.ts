import type { PaletteMemory } from '@/components/dashboard/command-palette';
import { getServices } from '@/lib/services';

/**
 * The command palette's corpus, read once by the dashboard layout rather than
 * fetched by the palette. Two reasons for the server read: the palette stays a
 * pure client-side filter with no request per keystroke, and the dashboard grows
 * no extra JSON endpoint for it.
 *
 * The corpus is bounded on purpose. It is the most recent `PALETTE_MEMORY_LIMIT`
 * active memories, not the whole table: the read is one index-backed `LIMIT`
 * query in `adminList`'s `created_at DESC` order, and shipping every title of a
 * 50k-memory install into every dashboard page would cost more than the feature
 * is worth. The palette's empty state is where that boundary is visible — a
 * memory outside the slice does not surface there, and the memories view (with
 * its FTS search) is the complete corpus.
 */
export const PALETTE_MEMORY_LIMIT = 250;

export function loadPaletteMemories(): PaletteMemory[] {
  const { repos } = getServices();

  const rows = repos.memory.adminList({
    status: 'active',
    limit: PALETTE_MEMORY_LIMIT,
    offset: 0,
  });
  if (rows.length === 0) return [];

  const slugById = new Map(repos.projects.adminListAll().map((p) => [p.id, p.slug]));
  return rows.map((m) => ({
    id: m.id,
    title: m.title,
    projectLabel: m.projectId ? (slugById.get(m.projectId) ?? '—') : '—',
  }));
}
