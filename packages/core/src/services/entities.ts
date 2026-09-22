import { type EntityKind } from '@rembric/db';

import { EXTRACTOR_RULES, type ExtractorRule } from './extractor-rules.js';

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

function admit(byKind: Map<EntityKind, Set<string>>): Map<EntityKind, Set<string>> {
  const kinds = [...byKind.keys()].sort();
  const counts = kinds.map((k) => byKind.get(k)!.size);
  const total = (q: number): number => counts.reduce((n, c) => n + Math.min(c, q), 0);

  const highest = Math.max(0, ...counts);
  let q = 0;
  while (q < highest && total(q + 1) <= MAX_ENTITIES) q += 1;

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

export function projectEntities<T extends { kind: string }>(
  entities: readonly T[],
  cap: number,
): { entities: T[]; entitiesTotal: number } {
  const total = entities.length;
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
