/**
 * Deterministic entity extraction — no LLM, no model, no network I/O.
 *
 * The patterns themselves live in `extractor-rules.ts`; this module is just
 * the bounded loop over them plus the per-kind budget. Symbol identifiers, package names,
 * semver strings, Docker image references and cron expressions are
 * deliberately absent — none can be bounded without matching prose.
 *
 * Precision over recall is the bar (design.md Decision 2): a false entity link
 * degrades exact lookup into bad text search, which is worse than missing a
 * real one. Tighten a pattern that pollutes the index and rebuild — never
 * loosen defensively "just in case".
 */

import type { EntityKind } from '../db/schema/entities.js';

import { EXTRACTOR_RULES, type ExtractorRule } from './extractor-rules.js';

/**
 * Version tag for the extraction recipe (patterns, normalization, kind set).
 * Bumping it invalidates the derived index at boot (`ensureEntityExtractor`)
 * so the backfill drain re-scans — same contract as `EMBEDDING_INPUT_VERSION`.
 * Bump whenever a pattern, a normalization rule, or `ENTITY_KINDS` changes.
 */
export const EXTRACTOR_VERSION = 'v7-tracked-dotfiles-fair-budget';

export interface ExtractedEntity {
  kind: EntityKind;
  /** Normalized so the same referent always yields the same key. */
  value: string;
}

/** Sliced BEFORE any regex runs, which is what bounds ReDoS exposure. */
const MAX_INPUT_CHARS = 200_000;
const MAX_TOKEN_CHARS = 300;
/** A `find` / lockfile dump yields thousands of paths, none of them addresses worth indexing. */
const MAX_ENTITIES = 250;

/**
 * Deduped normalized values in match order, stopping at the budget: collecting
 * every match of a 200KB dump and truncating after is the cost the bound exists
 * to avoid. Per rule, so the subset kept never depends on registry order.
 */
function collect(rule: ExtractorRule, text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(rule.pattern)) {
    if (seen.size >= MAX_ENTITIES) break;
    if (rule.accept && !rule.accept(m)) continue;
    const raw = m[rule.capture ?? 0] ?? m[0];
    if (raw.length === 0 || raw.length > MAX_TOKEN_CHARS) continue;
    const value = rule.normalize(raw);
    if (value) seen.add(value);
  }
  return [...seen];
}

/**
 * Max-min fair share of the budget across the kinds actually present: every
 * kind gets `min(its count, q)` for the largest `q` that fits, so a dominant
 * kind cannot starve the rest — a silently dropped kind is indistinguishable
 * from a memory that mentions none of it. A kind on its own still reaches the
 * whole bound, which an equal per-rule division would have truncated.
 */
function admit(byKind: Map<EntityKind, Set<string>>): Map<EntityKind, Set<string>> {
  const kinds = [...byKind.keys()].sort();
  const counts = kinds.map((k) => byKind.get(k)!.size);
  const total = (q: number): number => counts.reduce((n, c) => n + Math.min(c, q), 0);

  const highest = Math.max(0, ...counts);
  let q = 0;
  while (q < highest && total(q + 1) <= MAX_ENTITIES) q += 1;

  // Whole slots only, so the bound is "250" rather than "250 minus a rounding
  // artifact"; kinds are visited by name, never by registry position.
  let spare = MAX_ENTITIES - total(q);
  const admitted = new Map<EntityKind, Set<string>>();
  for (const kind of kinds) {
    const values = [...byKind.get(kind)!].sort();
    let take = Math.min(values.length, q);
    if (spare > 0 && values.length > take) {
      take += 1;
      spare -= 1;
    }
    admitted.set(kind, new Set(values.slice(0, take)));
  }
  return admitted;
}

/**
 * Bounded projection of a memory's entity list, plus its exact pre-bound total.
 *
 * Returned together on purpose: `a01d051` had to repair a read that projected ten
 * of twenty-seven entities and no count, breaking a guarantee published in the
 * same branch. Three call sites times two coupled fields is the shape that
 * produced it.
 *
 * The bound is applied to a max-min fair share across the kinds present — the
 * same rule `admit` applies to the extraction budget, for the same reason — not
 * to the `(kind, value)` order the repository returns. That order is stable but
 * alphabetical by KIND NAME, so on a memory that exceeds the bound it evicts
 * whole minority kinds and hands the surplus to whichever kind dominates.
 * Measured over this repo's commit bodies (284 at propose time, 285 today): the bound binds on 2, and both
 * lose an entire kind (their issue reference) under `(kind, value)` and none
 * under fair share.
 *
 * Entity kinds admit no defensible precedence — `ticket` does not outrank `path`
 * the way `conflicts_with` outranks `related` — so fair share is chosen over a
 * precedence tier precisely because it needs no such claim.
 *
 * Input order is the caller's; within a kind it is preserved, and kinds are
 * visited by ascending name so the result is a pure function of the input.
 */
export function projectEntities<T extends { kind: string }>(
  entities: readonly T[],
  cap: number,
): { entities: T[]; entitiesTotal: number } {
  const total = entities.length;
  // Truncated and floored: the loop's exit test is `length < bound`, so a
  // fractional bound would return ceil(bound) elements — more than asked for.
  const bound = Number.isFinite(cap) ? Math.max(0, Math.trunc(cap)) : 0;
  if (total <= bound) return { entities: [...entities], entitiesTotal: total };

  const byKind = new Map<string, T[]>();
  for (const entity of entities) {
    const group = byKind.get(entity.kind);
    if (group) group.push(entity);
    else byKind.set(entity.kind, [entity]);
  }
  const kinds = [...byKind.keys()].sort();

  const projected: T[] = [];
  for (let round = 0; projected.length < bound; round += 1) {
    let placedAny = false;
    for (const kind of kinds) {
      const group = byKind.get(kind)!;
      if (round >= group.length) continue;
      projected.push(group[round]!);
      placedAny = true;
      if (projected.length === bound) break;
    }
    if (!placedAny) break;
  }

  return { entities: projected, entitiesTotal: total };
}

export function extractEntities(title: string, content: string): ExtractedEntity[] {
  const text = `${title}\n\n${content}`.slice(0, MAX_INPUT_CHARS);
  const collected = EXTRACTOR_RULES.map((rule) => collect(rule, text));

  // Grouped by kind, not by rule: several rules can produce one kind, so a
  // per-rule share would turn on which rule happened to see a shared value.
  const byKind = new Map<EntityKind, Set<string>>();
  for (const [i, rule] of EXTRACTOR_RULES.entries()) {
    const values = byKind.get(rule.kind) ?? new Set<string>();
    for (const value of collected[i]!) values.add(value);
    byKind.set(rule.kind, values);
  }

  const admitted = admit(byKind);
  const out: ExtractedEntity[] = [];
  for (const [i, rule] of EXTRACTOR_RULES.entries()) {
    const remaining = admitted.get(rule.kind);
    for (const value of collected[i]!) {
      if (remaining?.delete(value)) out.push({ kind: rule.kind, value });
    }
  }
  return out;
}
