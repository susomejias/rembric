// Validations 2 and 3 on the 70-memory retrieval corpus, production arm (real embedder).
// Instrument: pending rows per scope and the drain decision per pair (not a timing).
// Run: DRAIN_SCRATCH=$(mktemp -d) TMPDIR=$DRAIN_SCRATCH pnpm --filter @rembric/core exec tsx ../../openspec/changes/drain-stale-save-time-pendings/measurements/corpus-drain.mts
const SCRATCH = process.env.DRAIN_SCRATCH;
if (!SCRATCH) throw new Error('set DRAIN_SCRATCH to a mktemp -d directory outside the workspace');

const P = await import('./drain-prototype.mts');
const { CORPUS, PROJECTS } = await import(
  new URL('packages/core/src/test-support/retrieval/corpus.ts', P.ROOT).href
);
const { ingestCorpus } = await import(
  new URL('packages/core/src/test-support/retrieval/ingest.ts', P.ROOT).href
);

const BATCH = 50;

interface Pair {
  key: string;
  judgmentId: string;
  sourceId: string;
  targetId: string;
  slug: string;
}

function stablePairs(handle: any, ingested: any): Pair[] {
  const stable = new Map<string, string>();
  for (const [s, id] of ingested.idByStableId) stable.set(id, s);
  const out: Pair[] = [];
  for (const [slug, projectId] of ingested.projectIdBySlug) {
    for (const p of P.pendingPairs(handle, projectId)) {
      out.push({ ...p, slug, key: `${stable.get(p.sourceId)} -> ${stable.get(p.targetId)}` });
    }
  }
  return out;
}

function activeSum(repos: any, ingested: any): number {
  let n = 0;
  for (const projectId of ingested.projectIdBySlug.values()) {
    n += repos.relations.countPendingInScope({ projectId });
  }
  return n;
}

function fmt(c: any): string {
  const lex = c.lexical === null ? '—' : c.lexical.toFixed(3);
  const vec = c.vector === null ? '—' : c.vector === 'missing' ? 'missing' : c.vector.toFixed(3);
  const ent = c.shared === null ? '—' : c.shared.length > 0 ? c.shared.join(',') : 'none';
  const re =
    c.reextracted === null
      ? ''
      : ` | re-extracted ${c.reextracted.length > 0 ? c.reextracted.join(',') : 'none'}`;
  return `lex ${lex} | vec ${vec} | stored entity ${ent}${re}`;
}

const embedder = P.memoized(await P.core.loadEmbedder());
const out: string[] = [
  '# stale pending drain — retrieval corpus (production arm), rules v3',
  `corpus: ${CORPUS.length} memories in ${PROJECTS.length} projects, ingested through runPostSaveSteps (ingestCorpus) at lexicalFloor 0, per-save cap 5; embedding model ${embedder.modelId}`,
  `drain batch B = ${BATCH} per scope, cursor in memory; scratch root ${SCRATCH}`,
  '',
];

const c0 = await ingestCorpus(CORPUS, embedder, { lexicalFloor: 0 });
const h0 = P.openDb(c0.dataDir);
const repos0 = P.db.createRepositories(h0.db);
const active0 = activeSum(repos0, c0);
const before = stablePairs(h0, c0);
out.push(
  `pending after ingest at 0.00: ${before.length} (both endpoints active: ${active0} — control: the committed series reports 289)`,
);
const decisions: any[] = [];
for (const [slug, projectId] of c0.projectIdBySlug) {
  const scopeBefore = P.pendingPairs(h0, projectId);
  const pass = P.drainOnePass(P.createContext(h0), projectId, BATCH);
  decisions.push(...pass.decisions.map((d: any) => ({ ...d, slug })));
  const v = P.verifyDrain(
    h0,
    projectId,
    scopeBefore,
    new Map(pass.decisions.map((d: any) => [d.judgmentId, d])),
  );
  out.push(
    `  scope ${slug.padEnd(8)} pending ${P.pad(scopeBefore.length, 4)}  runs ${pass.runs.length}  drained ${P.pad(pass.decisions.filter((d: any) => d.verdict === 'drained').length, 4)}  kept ${P.pad(pass.decisions.filter((d: any) => d.verdict === 'kept').length, 4)}  | validation 3: recomputed stale ${v.expectedDrained} retired ${v.expectedRetired} keep ${v.expectedKept}, mismatches ${v.mismatches.length}, max cosine delta ${v.maxVectorDelta.toExponential(1)}, near threshold ${v.nearVectorThreshold}`,
    ...v.mismatches.slice(0, 10).map((m: string) => `    MISMATCH ${m}`),
  );
}
const keyOf = new Map(before.map((p) => [p.judgmentId, p.key]));
const kept = decisions.filter((d) => d.verdict === 'kept');
const reasons = new Map<string, number>();
for (const d of kept) {
  const k = d.check.admitted.length > 0 ? d.check.admitted.join('+') : d.reason;
  reasons.set(k, (reasons.get(k) ?? 0) + 1);
}
out.push(
  `drained ${decisions.filter((d) => d.verdict === 'drained').length} (stale ${decisions.filter((d) => d.reason === 'drained:stale').length}, retired endpoint ${decisions.filter((d) => d.reason === 'drained:retired').length}), kept ${kept.length}, other ${decisions.filter((d) => d.verdict !== 'drained' && d.verdict !== 'kept').length}`,
  `kept by admitting-channel combination: ${[...reasons]
    .sort()
    .map(([k, n]) => `${k} ${n}`)
    .join(', ')}`,
  '',
);

const c6 = await ingestCorpus(CORPUS, embedder, { lexicalFloor: P.LEXICAL_FLOOR });
const h6 = P.openDb(c6.dataDir);
const repos6 = P.db.createRepositories(h6.db);
const p60 = stablePairs(h6, c6);
const active6 = activeSum(repos6, c6);
const p60Active = p60.filter((p) => {
  const rows = repos6.memory.unsafeGetByIds([p.sourceId, p.targetId]);
  return rows.length === 2 && rows.every((r: any) => r.status === 'active');
});
const keptKeys = new Set(kept.map((d) => keyOf.get(d.judgmentId)));
const keptActive = kept.filter((d) => d.check.endpoint === 'ok');
const p60Keys = new Set(p60.map((p) => p.key));
const p60ActiveKeys = new Set(p60Active.map((p) => p.key));
const notKept = p60.filter((p) => !keptKeys.has(p.key));
const extras = keptActive.filter((d) => !p60ActiveKeys.has(keyOf.get(d.judgmentId)!));
const before0Keys = new Set(before.map((p) => p.key));
out.push(
  '## validation 2 — kept set against the pendings ingest writes at the shipped floor (0.60)',
  `pending written at 0.60: ${p60.length} (both endpoints active: ${active6} — control: the committed series reports 54)`,
  `pairs written at 0.60 that were also written at 0.00: ${p60.filter((p) => before0Keys.has(p.key)).length}/${p60.length}`,
  `kept by the drain: ${kept.length} (both endpoints active ${keptActive.length}; kept by the endpoint fail-safe ${kept.length - keptActive.length})`,
  `written at 0.60 and kept: ${p60.length - notKept.length}; written at 0.60 but NOT kept: ${notKept.length}`,
  ...notKept.map((p) => `  NOT KEPT ${p.slug} ${p.key}`),
  `kept with active endpoints but not written at 0.60: ${extras.length}`,
);

const detect = (repos: any, sourceId: string, poolSize: number) => {
  const [saved] = repos.memory.unsafeGetByIds([sourceId]);
  const ents = P.core.extractEntities(saved.title, saved.content);
  return P.core.findSaveTimeCandidates(repos, saved, { perSaveMax: 1000, poolSize }, ents);
};
for (const d of extras) {
  const pool20 = detect(repos0, d.sourceId, 20).candidates.find(
    (c: any) => c.targetId === d.targetId,
  );
  const poolAll = detect(repos0, d.sourceId, 100_000).candidates.find(
    (c: any) => c.targetId === d.targetId,
  );
  out.push(
    `  ${d.slug.padEnd(7)} ${keyOf.get(d.judgmentId)!.padEnd(58)} kept by ${d.check.admitted.join('+').padEnd(15)} ${fmt(d.check)}`,
    `          re-detection now (not at save time): pool 20 uncapped -> ${pool20 ? `surfaced via ${pool20.source}` : 'not surfaced'}; unbounded pool -> ${poolAll ? `surfaced via ${poolAll.source}` : 'not surfaced'}`,
  );
}
const retired = decisions.filter((d) => d.reason === 'drained:retired');
out.push(
  '',
  `drained as 'endpoint retired' (rules v2 and v3; v1 kept these by the endpoint fail-safe): ${retired.length}; of these written at 0.60 too: ${retired.filter((d) => p60Keys.has(keyOf.get(d.judgmentId)!)).length}`,
  ...retired.map(
    (d) =>
      `  ${d.slug.padEnd(7)} ${keyOf.get(d.judgmentId)!.padEnd(58)} source ${d.check.sourceStatus}, target ${d.check.targetStatus}`,
  ),
);

h6.close();
c6.cleanup();
h0.close();
c0.cleanup();
console.log(out.join('\n'));
