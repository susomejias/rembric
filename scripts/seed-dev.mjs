#!/usr/bin/env node
/**
 * Dev seed — inserts representative rows so every dashboard route has
 * something to render.
 *
 * Wipes nothing: only INSERTs. Safe to run repeatedly; re-runs add more
 * rows. If you want a clean slate, delete `$REMBRIC_DATA_DIR/data.db`
 * and let the server recreate it on next boot.
 *
 * Usage:
 *   REMBRIC_DATA_DIR=/path/to/data pnpm exec node scripts/seed-dev.mjs
 */

import { join } from 'node:path';

import Database from 'better-sqlite3';
import { ulid } from 'ulid';

const dataDir = process.env.REMBRIC_DATA_DIR;
if (!dataDir) {
  console.error('seed-dev: REMBRIC_DATA_DIR is required');
  process.exit(1);
}
const dbPath = join(dataDir, 'data.db');
console.log(`seed-dev: opening ${dbPath}`);
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const adminToken = db
  .prepare(`SELECT id FROM tokens WHERE scope = '*' ORDER BY created_at ASC LIMIT 1`)
  .get();
if (!adminToken) {
  console.error('seed-dev: no admin token found — start the server at least once to bootstrap.');
  process.exit(1);
}
const adminTokenId = adminToken.id;
console.log(`seed-dev: admin token ${adminTokenId}`);

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

function ts(offsetMs) {
  return NOW + offsetMs;
}

function makeId(offsetMs) {
  return ulid(NOW + offsetMs);
}

/* ── projects ───────────────────────────────────────────────────── */
const PROJECTS = [
  { slug: 'rembric', name: 'Rembric (this repo)' },
  { slug: 'hermes', name: 'Hermes — agent runtime' },
  { slug: 'legacy-flow', name: null, archived: true },
];

const projectIds = {};
const insertProject = db.prepare(
  `INSERT OR IGNORE INTO projects (id, slug, display_name, archived_at, created_at)
   VALUES (?, ?, ?, ?, ?)`,
);
for (const [i, p] of PROJECTS.entries()) {
  const id = makeId(-DAY * (PROJECTS.length - i));
  const archivedAt = p.archived ? ts(-3 * DAY) : null;
  insertProject.run(id, p.slug, p.name, archivedAt, ts(-DAY * (PROJECTS.length - i)));
  const row = db.prepare(`SELECT id FROM projects WHERE slug = ?`).get(p.slug);
  projectIds[p.slug] = row.id;
}
console.log(`seed-dev: projects ready (${Object.keys(projectIds).length})`);

/* ── agent sessions ─────────────────────────────────────────────── */
const SESSIONS = [
  {
    agent: 'claude-code',
    project: 'rembric',
    offsetMs: -2 * HOUR,
    status: 'ended',
    summary: 'Wire up new judgments queue endpoint + UI.',
  },
  {
    agent: 'codex-cli',
    project: 'hermes',
    offsetMs: -3 * HOUR,
    status: 'ended',
    summary: 'Refactor search tool to return score as L2.',
  },
  {
    agent: 'hermes-orchestrator',
    project: null,
    offsetMs: -13 * HOUR,
    status: 'active',
    summary: null,
  },
  {
    agent: 'claude-code',
    project: 'rembric',
    offsetMs: -5 * HOUR,
    status: 'ended',
    summary: 'Dashboard redesign — phase 1 (tokens + atoms).',
  },
  {
    agent: 'codex-cli',
    project: 'rembric',
    offsetMs: -25 * HOUR,
    status: 'ended',
    summary: 'Doc pass on plugin install flow.',
  },
  { agent: 'cursor', project: 'hermes', offsetMs: -28 * HOUR, status: 'abandoned', summary: null },
];

const sessionIds = [];
const insertSession = db.prepare(
  `INSERT INTO sessions (id, token_id, project_id, agent, description, started_at, ended_at, summary, status, deleted_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
for (const s of SESSIONS) {
  const id = makeId(s.offsetMs);
  const startedAt = ts(s.offsetMs);
  const endedAt = s.status === 'active' ? null : ts(s.offsetMs + 45 * 60 * 1000);
  insertSession.run(
    id,
    adminTokenId,
    s.project ? projectIds[s.project] : null,
    s.agent,
    s.summary ? s.summary.slice(0, 60) : null,
    startedAt,
    endedAt,
    s.summary,
    s.status,
    null,
  );
  sessionIds.push({ id, project: s.project ?? null });
}
console.log(`seed-dev: sessions ready (${sessionIds.length})`);

/* ── memories ───────────────────────────────────────────────────── */
const MEMORIES = [
  {
    scope: 'global',
    type: 'user',
    content: 'Prefer Spanish in chat copy and English in code/comments. Spec/PRDs in Spanish.',
    tags: ['user-pref', 'language'],
    offsetMs: -22 * DAY,
  },
  {
    scope: 'project',
    project: 'rembric',
    type: 'project',
    content:
      'Dashboard stays SSR (Hono + tagged template literals) + HTMX. No SPA, no JS bundler. Tailwind is forbidden — design system lives in src/dashboard/styles/.',
    tags: ['arch', 'frontend'],
    offsetMs: -9 * DAY,
    topicKey: 'frontend-stack',
  },
  {
    scope: 'project',
    project: 'rembric',
    type: 'feedback',
    content:
      'Dashboard home is too flat: needs real observability — timeline of sessions, pending judgments queue, health strip.',
    tags: ['ux', 'feedback'],
    offsetMs: -3 * DAY,
  },
  {
    scope: 'global',
    type: 'reference',
    content:
      'Design ref: AI.OVERVIEW · § 01 / FOUNDATIONS poster — dark bg, lime as highlighter/cinta only, grotesk + jetbrains mono.',
    tags: ['design', 'reference'],
    offsetMs: -3 * DAY,
  },
  {
    scope: 'project',
    project: 'rembric',
    type: 'project',
    content:
      'Memory.save returns candidates[] when FTS or vec similarity > threshold. Agent must close each via memory.judge.',
    tags: ['mcp', 'judgment'],
    offsetMs: -8 * DAY,
  },
  {
    scope: 'project',
    project: 'hermes',
    type: 'project',
    content:
      'Hermes orchestrator routes per-tool requests over MCP; treats Rembric as the memory plane.',
    tags: ['arch'],
    offsetMs: -10 * DAY,
  },
  {
    scope: 'project',
    project: 'rembric',
    type: 'feedback',
    content:
      'Sidebar should be collapsible on desktop and become a drawer on ≤980 px. Persist collapse via cookie so SSR matches.',
    tags: ['ux'],
    offsetMs: -2 * DAY,
    topicKey: 'sidebar-ux',
  },
  {
    scope: 'global',
    type: 'feedback',
    content:
      'Default to NO comments. Comments only when their absence costs a reader real time — magic numbers, invariants, workarounds, public docstrings.',
    tags: ['style', 'rule'],
    offsetMs: -30 * DAY,
  },
  {
    scope: 'project',
    project: 'rembric',
    type: 'reference',
    content:
      'Reference: example-design/dashboard/ — React prototype used as the visual single-source-of-truth for the redesign (NOT imported into src/).',
    tags: ['design', 'reference'],
    offsetMs: -1 * DAY,
  },
  {
    scope: 'project',
    project: 'hermes',
    type: 'feedback',
    content:
      'Stop apologizing in agent responses. Say what changed, what to do next; no "I am sorry for the confusion".',
    tags: ['tone'],
    offsetMs: -25 * DAY,
  },
  {
    scope: 'global',
    type: 'user',
    content:
      'If unsure, hedge softly with "I might be wrong, but" — never assert facts that need a citation as bare statements.',
    tags: ['tone', 'user-pref'],
    offsetMs: -28 * DAY,
  },
  {
    scope: 'project',
    project: 'rembric',
    type: 'project',
    content:
      'Brutalist tokens locked: --bg #0a0a0a, --lime #c6f24e. Changing any of them needs an OpenSpec change.',
    tags: ['arch', 'design-tokens'],
    offsetMs: -6 * HOUR,
    topicKey: 'frontend-stack',
  },
];

const insertMemory = db.prepare(
  `INSERT INTO memory (id, scope, project_id, type, content, tags, status, replaces, created_at, last_seen_at, source, session_id, topic_key)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

// Walk topic_key supersession: same topic_key under same (scope, project)
// → the most recent wins, earlier rows go superseded.
const lastByTopic = new Map();
const memoryRows = [];
for (const m of MEMORIES) {
  const id = makeId(m.offsetMs);
  const scopeKey = `${m.scope}:${m.project ?? ''}:${m.topicKey ?? ''}`;
  let status = 'active';
  const replaces = [];
  if (m.topicKey) {
    const prev = lastByTopic.get(scopeKey);
    if (prev) {
      // Mark the previous one superseded.
      db.prepare(`UPDATE memory SET status = 'superseded' WHERE id = ?`).run(prev.id);
      replaces.push(prev.id);
    }
    lastByTopic.set(scopeKey, { id, content: m.content });
  }
  // Sprinkle an archived one for variety: a very old, low-priority feedback.
  if (m.offsetMs < -25 * DAY && m.type === 'feedback') {
    status = 'archived';
  }
  const session = sessionIds.find((s) => (s.project ?? null) === (m.project ?? null));
  insertMemory.run(
    id,
    m.scope,
    m.project ? projectIds[m.project] : null,
    m.type,
    m.content,
    JSON.stringify(m.tags ?? []),
    status,
    JSON.stringify(replaces),
    ts(m.offsetMs),
    ts(m.offsetMs + 3 * HOUR),
    JSON.stringify({ tokenName: 'admin', agent: 'claude-code' }),
    session?.id ?? null,
    m.topicKey ?? null,
  );
  memoryRows.push({ id, status, scope: m.scope, project: m.project ?? null });
}
console.log(`seed-dev: memories ready (${memoryRows.length})`);

/* ── relations (judgment queue) ─────────────────────────────────── */
// Pair some same-scope memories and mark them pending / judged.
function findPair(scope, project) {
  const candidates = memoryRows.filter(
    (m) => m.scope === scope && (m.project ?? null) === (project ?? null) && m.status === 'active',
  );
  if (candidates.length < 2) return null;
  return [candidates[0], candidates[1]];
}

const insertRelation = db.prepare(
  `INSERT INTO memory_relations
   (id, judgment_id, source_id, target_id, relation, status, reason, evidence, confidence, marked_by_kind, marked_by_actor, judged_at, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const RELATIONS = [
  {
    scope: 'project',
    project: 'rembric',
    status: 'pending',
    relation: null,
    reason: null,
    judged: false,
  },
  {
    scope: 'project',
    project: 'rembric',
    status: 'judged',
    relation: 'related',
    reason: 'Same design redesign work — different facets.',
    judged: true,
  },
  {
    scope: 'project',
    project: 'hermes',
    status: 'judged',
    relation: 'compatible',
    reason: 'Both scoped to hermes runtime; no conflict.',
    judged: true,
  },
  {
    scope: 'global',
    project: null,
    status: 'orphaned',
    relation: null,
    reason: 'Consolidator gave up after timeout.',
    judged: false,
  },
  {
    scope: 'project',
    project: 'rembric',
    status: 'pending',
    relation: null,
    reason: null,
    judged: false,
  },
];
let relCount = 0;
for (const r of RELATIONS) {
  const pair = findPair(r.scope, r.project);
  if (!pair) continue;
  const id = makeId(-relCount * HOUR);
  const judgmentId = makeId(-relCount * HOUR - 30);
  insertRelation.run(
    id,
    judgmentId,
    pair[0].id,
    pair[1].id,
    r.relation,
    r.status,
    r.reason,
    null,
    r.relation ? 0.85 : null,
    r.judged ? 'agent' : r.status === 'orphaned' ? 'consolidator' : null,
    r.judged ? 'claude-code' : null,
    r.judged || r.status === 'orphaned' ? ts(-relCount * HOUR - 10) : null,
    ts(-relCount * HOUR - 60),
  );
  relCount++;
}
console.log(`seed-dev: relations ready (${relCount})`);

/* ── consolidation runs + ops ───────────────────────────────────── */
const runId = makeId(-12 * HOUR);
db.prepare(
  `INSERT INTO consolidation_runs (id, started_at, finished_at, llm_provider, llm_model, scope, summary)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
).run(
  runId,
  ts(-12 * HOUR),
  ts(-12 * HOUR + 2 * 60 * 1000),
  'openai',
  'qwen2.5:7b',
  `project:${projectIds.rembric}`,
  'Decayed 3 archived memories; superseded 1 redundant pair.',
);

const insertOp = db.prepare(
  `INSERT INTO consolidation_ops
   (id, consolidation_id, op_type, affected_ids, created_id, reasoning, applied_at, reverted_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
const opSamples = [
  {
    type: 'decay',
    affected: memoryRows.slice(0, 1).map((m) => m.id),
    reasoning: 'Memory unseen > 30d and superseded; decayed to archived.',
  },
  {
    type: 'supersede',
    affected: memoryRows.slice(1, 3).map((m) => m.id),
    reasoning: 'Newer feedback overrode older.',
  },
  { type: 'noop', affected: [], reasoning: 'No qualifying candidates this pass.' },
];
for (const [i, op] of opSamples.entries()) {
  insertOp.run(
    makeId(-12 * HOUR + i * 60_000),
    runId,
    op.type,
    JSON.stringify(op.affected),
    null,
    op.reasoning,
    ts(-12 * HOUR + i * 60_000),
    null,
  );
}
console.log(`seed-dev: consolidation run + ${opSamples.length} ops ready`);

console.log('seed-dev: done.');
db.close();
