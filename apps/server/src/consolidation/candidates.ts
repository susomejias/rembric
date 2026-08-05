/**
 * Consolidation scope key.
 *
 * The consolidator now does only decay + orphan promotion. The v0.1
 * detectors `findRedundancyCandidates` / `findDriftCandidates` /
 * `findContradictionCandidates` were removed — the same work happens
 * at save-time via `MemoryService.saveWithTopicKey` +
 * `findSaveTimeCandidates`, and the `memory_relations` orphan-promotion
 * pass picks up anything the agent never judged.
 *
 * `ScopeKey` is the remaining shared type used by the runner to filter
 * decay candidates one scope at a time.
 */

export interface ScopeKey {
  projectId: string;
}
