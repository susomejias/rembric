import { inScope, type IngestedCorpus, type Retriever } from '../types.js';

interface GrepState {
  items: { id: string; haystack: string; scope: 'global' | 'project'; projectId: string | null }[];
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

/**
 * Naive lowercase substring/keyword scoring over `title + content`, no
 * index — the honest control (design.md Decision 4). Score is the count of
 * query tokens present as a substring anywhere in the haystack; items with
 * zero matches are excluded, not merely ranked last.
 */
export const grepRetriever: Retriever<GrepState> = {
  name: 'grep',
  discriminatingMetric: `recall@k vs 'hybrid' — how far naive substring matching gets alone`,
  init: (corpus: IngestedCorpus): GrepState => ({
    items: corpus.items.map((m) => ({
      id: m.id,
      haystack: `${m.title}\n\n${m.content}`.toLowerCase(),
      scope: m.scope,
      projectId: m.projectId,
    })),
  }),
  query(text, state, k, scope) {
    const tokens = tokenize(text);
    const scored = state.items
      .filter((item) => inScope(item, scope))
      .map((item) => ({
        id: item.id,
        score: tokens.reduce((acc, t) => acc + (item.haystack.includes(t) ? 1 : 0), 0),
      }))
      .filter((s) => s.score > 0);
    scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return { ids: scored.slice(0, k).map((s) => s.id) };
  },
};
