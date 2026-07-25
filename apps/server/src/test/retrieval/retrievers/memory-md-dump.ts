import { approxTokens } from '../scoring.js';
import { inScope, type IngestedCorpus, type IngestedMemory, type Retriever } from '../types.js';

/** Roughly a modest CLAUDE.md memory section — the budget a context dump would realistically get. */
const TOKEN_BUDGET = 2000;

interface DumpState {
  items: IngestedMemory[];
}

/**
 * The "just put it in CLAUDE.md" alternative (design.md Decision 4): ignores
 * the query entirely and returns the N most recent memories in scope, up to
 * a token budget — whichever bound is hit first.
 */
export const memoryMdDumpRetriever: Retriever<DumpState> = {
  name: 'memory-md-dump',
  discriminatingMetric: `avgTokensReturned vs 'hybrid' at comparable recall — the token cost of the context-dump alternative`,
  init: (corpus: IngestedCorpus): DumpState => ({
    items: [...corpus.items].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
  }),
  query(_text, state, k, scope) {
    const ids: string[] = [];
    let budget = TOKEN_BUDGET;
    for (const item of state.items) {
      if (ids.length >= k) break;
      if (!inScope(item, scope)) continue;
      const cost = approxTokens(`${item.title}\n\n${item.content}`);
      if (cost > budget) break;
      budget -= cost;
      ids.push(item.id);
    }
    return ids;
  },
};
