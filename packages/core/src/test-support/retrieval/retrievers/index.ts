import type { Retriever } from '../types.js';

import { grepRetriever } from './grep.js';
import { hybridRetriever } from './hybrid.js';
import { memoryMdDumpRetriever } from './memory-md-dump.js';
import { rerankedRetriever } from './reranked.js';

export { grepRetriever } from './grep.js';
export { hybridRetriever } from './hybrid.js';
export { memoryMdDumpRetriever } from './memory-md-dump.js';
export { rerankedRetriever } from './reranked.js';

export const RETRIEVERS: Retriever<unknown>[] = [
  hybridRetriever,
  rerankedRetriever,
  grepRetriever,
  memoryMdDumpRetriever,
];
