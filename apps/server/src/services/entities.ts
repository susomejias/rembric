/**
 * Deterministic entity extraction — no LLM, no model, no network I/O.
 *
 * The patterns themselves live in `extractor-rules.ts`; this module is just
 * the bounded loop over them plus dedup. Symbol identifiers, package names,
 * semver strings, Docker image references and cron expressions are
 * deliberately absent — none can be bounded without matching prose.
 *
 * Precision over recall is the bar (design.md Decision 2): a false entity link
 * degrades exact lookup into bad text search, which is worse than missing a
 * real one. Tighten a pattern that pollutes the index and rebuild — never
 * loosen defensively "just in case".
 */

import type { EntityKind } from '../db/schema/entities.js';

import { EXTRACTOR_RULES } from './extractor-rules.js';

/**
 * Version tag for the extraction recipe (patterns, normalization, kind set).
 * Bumping it invalidates the derived index at boot (`ensureEntityExtractor`)
 * so the backfill drain re-scans — same contract as `EMBEDDING_INPUT_VERSION`.
 * Bump whenever a pattern, a normalization rule, or `ENTITY_KINDS` changes.
 */
export const EXTRACTOR_VERSION = 'v4-systemd-and-mac';

export interface ExtractedEntity {
  kind: EntityKind;
  /** Normalized so the same referent always yields the same key. */
  value: string;
}

/** Sliced BEFORE any regex runs, which is what bounds ReDoS exposure. */
const MAX_INPUT_CHARS = 200_000;
const MAX_TOKEN_CHARS = 300;

export function extractEntities(title: string, content: string): ExtractedEntity[] {
  const text = `${title}\n\n${content}`.slice(0, MAX_INPUT_CHARS);
  const seen = new Set<string>();
  const out: ExtractedEntity[] = [];

  for (const rule of EXTRACTOR_RULES) {
    for (const m of text.matchAll(rule.pattern)) {
      if (rule.accept && !rule.accept(m)) continue;
      const raw = m[rule.capture ?? 0] ?? m[0];
      if (raw.length === 0 || raw.length > MAX_TOKEN_CHARS) continue;
      const value = rule.normalize(raw);
      if (!value) continue;
      const key = `${rule.kind}:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: rule.kind, value });
    }
  }

  return out;
}
