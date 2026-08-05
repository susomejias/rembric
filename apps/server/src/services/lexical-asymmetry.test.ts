import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { seedProject } from '../test/default-project.js';
import { createTestDb, type TestDb } from '../test/index.js';

import {
  hybridSearch,
  indexTerms,
  relevanceComponents,
  termWeight,
  termWeightsFor,
  type GateLeader,
} from './hybrid-search.js';
import { projectScope } from './scope.js';

/**
 * The lexical component's two halves are sourced differently and the asymmetry
 * is contracted — memory/spec.md, "Term-statistics lookups MUST be keyed on the
 * index's own terms". The query side is the index's; the row side is
 * `indexTerms`, whose disagreement may only under-count. Both halves are
 * asserted over scripts the committed en/es eval corpus cannot contain.
 */

const SCRIPTS = [
  { name: 'Cyrillic with й/ё', text: 'майский район войти ёлка' },
  { name: 'Greek with a final sigma', text: 'στάσις αναζήτηση ολοκληρώθηκε τέλος' },
  { name: 'Vietnamese', text: 'kiểm tra bộ nhớ đệm đã hoàn thành' },
  { name: 'Japanese', text: 'バンド設定のデバッグを完了しました' },
];

let db: TestDb;
let repos: Repositories;

function save(id: string, content: string): void {
  db.handle.raw
    .prepare(
      `INSERT INTO memory (id, scope, project_id, type, title, content, status, created_at)
       VALUES (?, 'global', NULL, 'reference', 'title', ?, 'active', 0)`,
    )
    .run(id, content);
}

/** The index's own document frequency, read independently of the repository. */
function indexDf(term: string): number | undefined {
  return db.handle.raw
    .prepare<[string], { doc: number }>(`SELECT doc FROM memory_fts_vocab WHERE term = ?`)
    .get(term)?.doc;
}

beforeEach(() => {
  db = createTestDb();
  seedProject(db.handle, 'p0', 'project-zero');
  repos = createRepositories(db.handle.db);
});
afterEach(() => db.cleanup());

describe('the query side resolves to the document frequency the index records', () => {
  for (const script of SCRIPTS) {
    it(`does not fabricate a term for ${script.name}`, () => {
      for (let i = 0; i < 4; i++) save(`${script.name}-${i}`, `${script.text} nota ${i}`);

      const stats = repos.termStatistics.adminQueryTermFrequencies(script.text);
      expect(stats.size).toBeGreaterThan(0);
      for (const [term, doc] of stats) {
        expect(doc, `${term} must resolve to the index's own count`).toBe(indexDf(term));
        expect(doc, `${term} must not be reported absent`).not.toBeNull();
      }

      // The application's tokenisation of the same text produces at least one
      // term the index does NOT hold — this is why the read is not keyed on it.
      const fabricated = [...new Set(indexTerms(script.text))].filter(
        (t) => indexDf(t) === undefined,
      );
      expect(fabricated.length, `${script.name}: ${fabricated.join(' ')}`).toBeGreaterThan(0);
    });
  }

  it('CONTROL: a term the corpus really lacks is still reported absent', () => {
    save('m1', 'майский район');
    const stats = repos.termStatistics.adminQueryTermFrequencies('майский nowherenearthecorpus');
    expect(stats.get('майский')).toBe(1);
    expect(stats.get('nowherenearthecorpus')).toBeNull();
  });

  it('is what the search path itself weights by, not a function beside it', async () => {
    for (const script of SCRIPTS) {
      for (let i = 0; i < 3; i++) save(`${script.name}-${i}`, `${script.text} nota ${i}`);
    }

    for (const script of SCRIPTS) {
      let leader: GateLeader | undefined;
      await hybridSearch({
        repos,
        query: script.text,
        scope: projectScope('p0'),
        status: 'active',
        limit: 8,
        offset: 0,
        relativeLevelRatio: 0.4,
        onGateWindow: (l) => {
          leader = l;
        },
      });
      expect(leader?.documentFrequencies.size, script.name).toBeGreaterThan(0);
      for (const [term, doc] of leader!.documentFrequencies) {
        expect(doc, `${script.name}: ${term}`).toBe(indexDf(term));
      }
    }
  });
});

describe('a row-side disagreement can only under-count', () => {
  const COSINE = 0.42;

  it('lowers coverage, leaves the level at the cosine, and never takes the absent-term weight', () => {
    const HELD = 'майский';
    for (let i = 0; i < 5; i++) save(`ru-${i}`, `${HELD} район ${i}`);
    save('unrelated', 'ninguna palabra compartida');

    const n = repos.termStatistics.adminDocumentCount();
    const stats = repos.termStatistics.adminQueryTermFrequencies(HELD);
    const weightOf = termWeightsFor(n, stats);
    expect(stats.get(HELD)).toBe(5);

    // Not the absent-term maximum: the index reported the term, so its weight is
    // the weight of a term five of six rows hold.
    expect(weightOf(HELD)).toBeLessThan(termWeight(n, 0));
    expect(weightOf(HELD)).toBe(termWeight(n, 5));

    const queryTokens = new Set(stats.keys());
    const containing = { title: 'Заметка', content: `${HELD} район 1` };
    const lacking = { title: 'Nota', content: 'ninguna palabra compartida' };

    const covered = relevanceComponents(queryTokens, containing, COSINE, weightOf);
    const absent = relevanceComponents(queryTokens, lacking, COSINE, weightOf);

    // `indexTerms` mangles the й, so the row's own term does not match the
    // index's — counted as not covered, which is no higher than a row that
    // genuinely lacks it.
    expect(covered.coverage).toBe(0);
    expect(covered.coverage).toBeLessThanOrEqual(absent.coverage);
    // The dense branch is untouched, so the row is still reachable on its cosine.
    expect(covered.cosine).toBe(COSINE);
    expect(covered.level).toBe(COSINE);
  });

  it('CONTROL: the same construction covers the term when the two tokenisations agree', () => {
    const HELD = 'scheduler';
    for (let i = 0; i < 5; i++) save(`en-${i}`, `${HELD} restart ${i}`);

    const stats = repos.termStatistics.adminQueryTermFrequencies(HELD);
    const weightOf = termWeightsFor(repos.termStatistics.adminDocumentCount(), stats);
    const components = relevanceComponents(
      new Set(stats.keys()),
      { title: 'Note', content: `${HELD} restart 1` },
      COSINE,
      weightOf,
    );
    expect(components.coverage).toBe(1);
    expect(components.level).toBe(1);
  });
});
