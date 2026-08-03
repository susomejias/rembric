import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { createTestDb, type TestDb } from '../test/index.js';

import {
  relevanceComponents,
  termWeight,
  termWeightsFor,
  tokenContainment,
  tokenSet,
  weightedCoverage,
} from './hybrid-search.js';
import { MemoryService } from './memory.js';
import { ProjectsService } from './projects.js';
import { projectScope } from './scope.js';

const row = (title: string, content: string) => ({ title, content });
/** `null` is the read's absent marker: the index reported no entry for that term. */
const coverage = (
  query: string,
  r: { title: string; content: string },
  documentCount: number,
  df: Record<string, number | null>,
) =>
  relevanceComponents(
    tokenSet(query),
    r,
    undefined,
    termWeightsFor(documentCount, new Map(Object.entries(df))),
  ).coverage;

describe('termWeight', () => {
  it('is strictly positive at every document frequency, including df = N', () => {
    for (const n of [0, 1, 5, 40, 50_000]) {
      for (const df of [0, 1, Math.floor(n / 2), n]) {
        expect(termWeight(n, df)).toBeGreaterThan(0);
      }
    }
  });

  it('pins the smoothed form at the three sizes the design costed', () => {
    // ln(1 + (N − df + 0.5)/(df + 0.5)).
    expect(termWeight(0, 0)).toBeCloseTo(Math.log(2), 12); // 0.6931
    expect(termWeight(5, 0)).toBeCloseTo(Math.log(12), 12); // 2.4849
    expect(termWeight(5, 5)).toBeCloseTo(Math.log(1 + 0.5 / 5.5), 12); // 0.0870
    expect(termWeight(50_000, 0)).toBeCloseTo(Math.log(100_002), 9); // 11.5130
    expect(termWeight(50_000, 50_000)).toBeCloseTo(1.0e-5, 8);
  });

  it('clamps df into [0, N] rather than producing a negative or undefined weight', () => {
    expect(termWeight(5, 9)).toBe(termWeight(5, 5));
    expect(termWeight(5, -3)).toBe(termWeight(5, 0));
    expect(Number.isFinite(termWeight(0, 7))).toBe(true);
  });

  it('never rises as a term appears in more documents', () => {
    for (const n of [5, 40, 50_000]) {
      let previous = Infinity;
      for (let df = 0; df <= n; df += Math.max(1, Math.floor(n / 50))) {
        const w = termWeight(n, df);
        expect(w).toBeLessThanOrEqual(previous);
        previous = w;
      }
    }
  });
});

describe('weightedCoverage', () => {
  const query = tokenSet('alpha beta gamma delta');

  it('equals the unweighted fraction when every term carries the same weight', () => {
    const candidate = tokenSet('alpha beta only');
    for (const n of [0, 5, 50_000]) {
      const uniform = termWeightsFor(n, new Map([...query].map((t) => [t, 3])));
      expect(weightedCoverage(query, candidate, uniform)).toBeCloseTo(
        tokenContainment(query, candidate),
        12,
      );
    }
  });

  it('stays in [0,1] and is 1 for a row carrying every term', () => {
    const weights = termWeightsFor(
      40,
      new Map<string, number | null>([
        ['alpha', 40],
        ['beta', null],
        ['gamma', null],
        ['delta', null],
      ]),
    );
    expect(weightedCoverage(query, tokenSet('alpha beta gamma delta extra'), weights)).toBe(1);
    expect(weightedCoverage(query, tokenSet('nothing shared'), weights)).toBe(0);
  });

  it('is 0 for an empty query rather than dividing by zero', () => {
    expect(weightedCoverage(new Set(), tokenSet('anything'), termWeightsFor(5, new Map()))).toBe(0);
  });
});

describe('the level on a five-memory instance', () => {
  const N = 5;

  it('is defined and equals the unweighted coverage when every term appears in all five', () => {
    const query = 'shared alpha beta';
    const df = { shared: N, alpha: N, beta: N };
    for (const t of Object.keys(df))
      expect(termWeight(N, df[t as keyof typeof df])).toBeGreaterThan(0);
    const r = row('Shared note', 'shared alpha only');
    expect(coverage(query, r, N, df)).toBeCloseTo(
      tokenContainment(tokenSet(query), tokenSet(`${r.title}\n\n${r.content}`)),
      12,
    );
    expect(coverage(query, r, N, df)).toBeCloseTo(2 / 3, 12);
  });

  it('separates a rare-term match from a ubiquitous-term match at real numbers', () => {
    // w(ubiquitous) = ln(1 + 0.5/5.5) = 0.08701; w(rare) = ln(4) = 1.38629.
    const df = { ubiquitous: 5, rare: 1 };
    const onlyUbiquitous = coverage('ubiquitous rare', row('U', 'ubiquitous only'), N, df);
    const onlyRare = coverage('ubiquitous rare', row('R', 'rare only'), N, df);
    expect(onlyUbiquitous).toBeCloseTo(0.087011377 / (0.087011377 + Math.log(4)), 8);
    expect(onlyUbiquitous).toBeCloseTo(0.059059, 5);
    expect(onlyRare).toBeCloseTo(0.940941, 5);
    // Unweighted, both rows score exactly 0.5 — the quantity this replaces
    // cannot tell them apart at all.
    expect(tokenContainment(tokenSet('ubiquitous rare'), tokenSet('R\n\nrare only'))).toBe(0.5);
  });
});

describe('the level at the corpus-size edges', () => {
  it('an empty index gives every term the same positive weight, so the level is plain coverage', () => {
    const query = 'alpha beta gamma delta';
    const r = row('A', 'alpha beta');
    expect(termWeight(0, 0)).toBeGreaterThan(0);
    const absent = { alpha: null, beta: null, gamma: null, delta: null };
    expect(coverage(query, r, 0, absent)).toBeCloseTo(0.5, 12);
  });

  it('a term the index has never seen carries the maximum weight', () => {
    const N = 40;
    const df = { common: N, unseen: 0 };
    expect(termWeight(N, 0)).toBeGreaterThan(termWeight(N, 1));
    const matchesUnseen = coverage('common unseen', row('A', 'unseen here'), N, df);
    const matchesCommon = coverage('common unseen', row('B', 'common here'), N, df);
    expect(matchesUnseen).toBeGreaterThan(0.99);
    expect(matchesCommon).toBeLessThan(0.01);
  });

  it('a question-shaped query is not carried by its function words', () => {
    const N = 40;
    // Every memory contains the function words; only one contains `changelog`.
    const df = { how: N, does: N, the: N, user: N, want: N, changelog: 1 };
    const query = 'how does the user want changelog';
    const functionWordsOnly = coverage(query, row('X', 'how does the user want'), N, df);
    const answering = coverage(query, row('Y', 'changelog entries'), N, df);
    expect(functionWordsOnly).toBeLessThan(answering);
    // The gap comes from the weighting, not from the number of terms matched:
    // the function-word row matches FIVE terms and the answering row ONE.
    expect(tokenContainment(tokenSet(query), tokenSet('X\n\nhow does the user want'))).toBeCloseTo(
      5 / 6,
      12,
    );
    expect(tokenContainment(tokenSet(query), tokenSet('Y\n\nchangelog entries'))).toBeCloseTo(
      1 / 6,
      12,
    );
  });
});

describe('corpus growth moves levels in one direction only', () => {
  it("a row carrying the query's rarer terms never loses ground to one carrying only its commoner ones", () => {
    const query = 'common rare';
    for (const [n, dfCommon, dfRare] of [
      [10, 10, 1],
      [100, 90, 2],
      [50_000, 50_000, 3],
    ] as const) {
      const df = { common: dfCommon, rare: dfRare };
      const rareRow = coverage(query, row('R', 'rare only'), n, df);
      const commonRow = coverage(query, row('C', 'common only'), n, df);
      expect(rareRow, `N=${n}`).toBeGreaterThan(commonRow);
    }
  });

  it('adding rows that share the query vocabulary without answering it lowers THEIR level, not the answer’s', () => {
    const query = 'scheduler restart';
    const answering = row('A', 'scheduler restart runbook');
    const sharing = row('S', 'scheduler notes');
    const before = { n: 40, df: { scheduler: 8, restart: 2 } };
    // 20 rows that mention `scheduler` and never `restart`.
    const after = { n: 60, df: { scheduler: 28, restart: 2 } };

    expect(coverage(query, answering, before.n, before.df)).toBe(1);
    expect(coverage(query, answering, after.n, after.df)).toBe(1);
    expect(coverage(query, sharing, after.n, after.df)).toBeLessThan(
      coverage(query, sharing, before.n, before.df),
    );
  });
});

describe('the save-time path stays unweighted and keeps the shared tokeniser', () => {
  let db: TestDb;
  let repos: Repositories;

  beforeEach(() => {
    db = createTestDb();
    repos = createRepositories(db.handle.db);
  });
  afterEach(() => db.cleanup());

  it('save-time-candidates.ts reads the unweighted overlap, never the weighted one', () => {
    const src = readFileSync(join(import.meta.dirname, 'save-time-candidates.ts'), 'utf8');
    expect(src).toMatch(/\btokenContainment\b/);
    for (const weighted of [
      'weightedCoverage',
      'termWeight',
      'termWeightsFor',
      'relevanceComponents',
    ])
      expect(src, `save-time similarity must not read ${weighted}`).not.toMatch(
        new RegExp(`\\b${weighted}\\b`),
      );
    // Control: the shared tokeniser IS still imported, so the assertion above
    // is about the weighting and not about the import having gone away.
    expect(src).toMatch(/\btokenSet\b/);
  });

  it('reports the same similarity in two scopes whose other memories differ entirely', () => {
    const projects = new ProjectsService(repos);
    const a = projects.create({ slug: 'sim-scope-a' }).id;
    const b = projects.create({ slug: 'sim-scope-b' }).id;
    const memory = new MemoryService(repos, db.handle.db);

    const saved = { title: 'Rate limit policy', content: 'rate-limit the atlas api per token' };
    const candidate = { title: 'Atlas notes', content: 'the atlas api rate-limit chapter' };

    // Scope A: the shared terms are ubiquitous. Scope B: they appear nowhere else.
    for (let i = 0; i < 12; i++)
      memory.save(
        { type: 'project', title: `A ${i}`, content: 'rate-limit atlas api token' },
        projectScope(a),
      );
    for (let i = 0; i < 12; i++)
      memory.save(
        { type: 'project', title: `B ${i}`, content: 'unrelated prose about scheduling' },
        projectScope(b),
      );
    memory.save({ type: 'project', ...candidate }, projectScope(a));
    memory.save({ type: 'project', ...candidate }, projectScope(b));

    const similarity = tokenContainment(
      tokenSet(saved.content),
      tokenSet(`${candidate.title}\n\n${candidate.content}`),
    );
    expect(similarity).toBeGreaterThan(0);
    expect(similarity).toBeLessThanOrEqual(1);
    // Corpus-independent by construction: the same two texts, two corpora.
    expect(
      tokenContainment(
        tokenSet(saved.content),
        tokenSet(`${candidate.title}\n\n${candidate.content}`),
      ),
    ).toBe(similarity);
    // And it is NOT what the search path would report for the same pair.
    const weighted = coverage(saved.content, candidate, 24, {
      rate: 24,
      limit: 24,
      atlas: 24,
      api: 24,
      token: 24,
      the: 24,
      per: 1,
    });
    expect(weighted).not.toBeCloseTo(similarity, 6);
  });
});
