#!/usr/bin/env node
/**
 * Fails when spec prose cites a requirement by title and no requirement carries that
 * title.
 *
 * Specs cross-reference each other constantly ("specified in this capability under
 * \"…\"", "governed by \"…\""), and nothing validates those pointers. When a change
 * replaces a requirement with a differently-titled one, every citation of the old
 * title becomes a pointer to nothing — and the published contract says "see a rule
 * that does not exist". An archiver run caught `openspec/specs/sessions/spec.md`
 * citing "A session summary MUST follow the documented structure" by hand; without
 * that catch it would have been published. `openspec validate --strict` checks shape,
 * `check-delta-freshness` compares MODIFIED blocks to the published text, and no test
 * parses requirement prose, so this class is invisible to the whole existing suite.
 *
 * WHAT IT DETECTS. A citation is a double-quoted (`"…"` or `“…”`) span that (a) is
 * preceded by a citation cue — under / titled / named / called / see / per / in /
 * from / of / to / requirement(s) / section — and (b) contains a modal (MUST, SHALL,
 * SHOULD, MAY). Titles and citations are compared with backticks stripped, whitespace
 * collapsed and a trailing period dropped, because the same title is quoted with and
 * without its inline code formatting.
 *
 *   - no requirement title matches, even loosely  -> BLOCKING. The pointer is dead.
 *   - the span is a strict prefix of exactly one title, or one title is a strict
 *     prefix of the span -> ADVISORY. A human resolves it, but it is a truncated
 *     citation that a future rename will silently break.
 *
 * Two passes run. The PUBLISHED pass resolves citations in `openspec/specs/` against
 * the titles published there; it is the gate. The PROJECTED pass resolves them
 * against the title set that the active changes in `openspec/changes/` will publish
 * (published titles, minus every REMOVED and RENAMED-FROM title, plus every ADDED and
 * RENAMED-TO title), scanning the delta's version of each requirement it rewrites
 * instead of the published one. That pass is where the sessions defect above shows
 * up — before archive, not after — and it is ADVISORY, because a change may
 * legitimately land the rename in one commit and the prose fix in the next.
 *
 * DELIBERATELY NOT ATTEMPTED, because each would trade a false negative for false
 * positives on correct text:
 *   - Modal-free titles ("Slug resolution cascade order"). A quoted modal-free phrase
 *     after "in" or "of" is indistinguishable from ordinary emphasis, and specs are
 *     full of both. Measured on the current published specs, requiring a modal keeps
 *     precision at 82/83 candidates resolving exactly.
 *   - Single-quoted and backticked spans. Apostrophes and inline code make `'…'` and
 *     `` `…` `` unparseable as delimiters; they produced ~440 junk candidates against
 *     ~100 real ones.
 *   - Whether the citation names the right CAPABILITY. Titles are pooled across all
 *     capabilities, so "in `mcp-api` under \"X\"" passes as long as some capability
 *     publishes X. Validating the capability too would need every "this capability"
 *     to be resolved relative to its own file, and cross-capability moves are
 *     legitimate and frequent.
 *   - `## REMOVED Requirements` blocks. A removal's Reason names the requirement it
 *     removes, so citing a title that is about to stop existing is correct there.
 *
 * Flags: `--root <dir>` points at a fixture tree instead of this repo — how the
 * co-located test drives it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootFlag = process.argv.indexOf('--root');
const repoRoot =
  rootFlag === -1
    ? join(dirname(fileURLToPath(import.meta.url)), '..')
    : process.argv[rootFlag + 1];
const specsDir = join(repoRoot, 'openspec', 'specs');
const changesDir = join(repoRoot, 'openspec', 'changes');

const CUE = '(?:under|titled|named|called|see|per|in|from|of|to|requirements?|section)';
const CITATION = new RegExp(
  String.raw`\b${CUE}\s+(?:the\s+)?(?:requirements?\s+)?["“]([^"”\n]{8,220})["”]`,
  'gi',
);
const MODAL = /\b(?:MUST|SHALL|SHOULD|MAY)\b/;
const normalize = (text) => text.replace(/`/g, '').replace(/\s+/g, ' ').trim().replace(/\.$/, '');

/**
 * Requirements as line ranges, tagged with their enclosing `## ` section. Fenced blocks
 * are skipped so a quoted markdown sample cannot register as a heading.
 */
function requirements(source) {
  const lines = source.split('\n');
  const found = [];
  let fence = null;
  let section = null;
  lines.forEach((line, i) => {
    const fenceMark = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMark) {
      if (fence === null) fence = fenceMark[1][0];
      else if (fenceMark[1][0] === fence) fence = null;
      return;
    }
    if (fence !== null) return;
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      section = heading[1].trim();
      if (found.length > 0) found[found.length - 1].end = i;
      return;
    }
    const req = /^### Requirement: (.*)$/.exec(line);
    if (req) {
      if (found.length > 0) found[found.length - 1].end = i;
      found.push({ name: req[1].trim(), section, start: i, end: lines.length });
    }
  });
  return { lines, found };
}

const publishedSpecs = readdirSync(specsDir)
  .map((capability) => ({ capability, path: join(specsDir, capability, 'spec.md') }))
  .filter((s) => statSync(s.path, { throwIfNoEntry: false }))
  .map((s) => ({ ...s, ...requirements(readFileSync(s.path, 'utf8')) }));

function activeDeltas() {
  if (!statSync(changesDir, { throwIfNoEntry: false })) return [];
  const out = [];
  for (const entry of readdirSync(changesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'archive') continue;
    const specRoot = join(changesDir, entry.name, 'specs');
    if (!statSync(specRoot, { throwIfNoEntry: false })) continue;
    for (const capability of readdirSync(specRoot)) {
      const path = join(specRoot, capability, 'spec.md');
      if (!statSync(path, { throwIfNoEntry: false })) continue;
      const source = readFileSync(path, 'utf8');
      const renamed = [];
      let from = null;
      for (const line of source.split('\n')) {
        const f = /^-\s*FROM:\s*`### Requirement: (.*)`\s*$/.exec(line);
        if (f) from = f[1].trim();
        const t = /^-\s*TO:\s*`### Requirement: (.*)`\s*$/.exec(line);
        if (t && from !== null) {
          renamed.push({ from, to: t[1].trim() });
          from = null;
        }
      }
      out.push({ change: entry.name, capability, path, renamed, ...requirements(source) });
    }
  }
  return out;
}

const deltas = activeDeltas();
const inSection = (delta, section) => delta.found.filter((r) => r.section === section);
const titlesIn = (delta, section) => inSection(delta, section).map((r) => r.name);

const publishedTitles = new Set(
  publishedSpecs.flatMap((s) => s.found.map((r) => normalize(r.name))),
);
const projectedTitles = new Set(publishedTitles);
for (const delta of deltas) {
  for (const name of titlesIn(delta, 'REMOVED Requirements'))
    projectedTitles.delete(normalize(name));
  for (const { from, to } of delta.renamed) {
    projectedTitles.delete(normalize(from));
    projectedTitles.add(normalize(to));
  }
  for (const name of titlesIn(delta, 'ADDED Requirements')) projectedTitles.add(normalize(name));
}

/** Citations inside `lines[start..end)`, with 1-based source line numbers. */
function citations(lines, start, end) {
  const block = lines.slice(start, end).join('\n');
  const out = [];
  for (const match of block.matchAll(CITATION)) {
    const text = normalize(match[1]);
    if (!MODAL.test(text)) continue;
    out.push({ text, line: start + block.slice(0, match.index).split('\n').length });
  }
  return out;
}

/** exact | truncated (a unique loose match, reported for tightening) | dangling */
function classify(text, titles) {
  if (titles.has(text)) return { verdict: 'exact' };
  const loose = [...titles].filter((t) => t.startsWith(text) || text.startsWith(t));
  if (loose.length === 1) return { verdict: 'truncated', title: loose[0] };
  return { verdict: 'dangling' };
}

const problems = [];
const advisories = [];
let candidates = 0;

for (const spec of publishedSpecs) {
  for (const requirement of spec.found) {
    for (const citation of citations(spec.lines, requirement.start, requirement.end)) {
      candidates += 1;
      const { verdict, title } = classify(citation.text, publishedTitles);
      const at = `openspec/specs/${spec.capability}/spec.md:${citation.line}`;
      if (verdict === 'dangling') {
        problems.push(
          `${at}: cites a requirement title that no published requirement carries:\n` +
            `      "${citation.text}"\n      (cited from: ${requirement.name})`,
        );
      } else if (verdict === 'truncated') {
        advisories.push(
          `${at}: citation is not the requirement's full title — a rename will break it silently:\n` +
            `      cited:     "${citation.text}"\n      published: "${title}"`,
        );
      }
    }
  }
}

if (deltas.length > 0) {
  const rewritten = new Set();
  for (const delta of deltas)
    for (const section of ['ADDED Requirements', 'MODIFIED Requirements', 'REMOVED Requirements'])
      for (const name of titlesIn(delta, section)) rewritten.add(`${delta.capability} ${name}`);
  for (const delta of deltas)
    for (const { from } of delta.renamed) rewritten.add(`${delta.capability} ${from}`);

  const projected = [];
  for (const spec of publishedSpecs)
    for (const requirement of spec.found) {
      // The delta carries this requirement's post-archive text; scan that copy instead.
      if (rewritten.has(`${spec.capability} ${requirement.name}`)) continue;
      projected.push({ label: `openspec/specs/${spec.capability}/spec.md`, spec, requirement });
    }
  for (const delta of deltas)
    for (const requirement of delta.found) {
      if (requirement.section === 'REMOVED Requirements' || requirement.section === null) continue;
      projected.push({
        label: `openspec/changes/${delta.change}/specs/${delta.capability}/spec.md`,
        spec: delta,
        requirement,
      });
    }

  for (const { label, spec, requirement } of projected)
    for (const citation of citations(spec.lines, requirement.start, requirement.end)) {
      const { verdict, title } = classify(citation.text, projectedTitles);
      if (verdict === 'exact') continue;
      advisories.push(
        `${label}:${citation.line}: after the active change(s) archive, this citation ` +
          `${verdict === 'dangling' ? 'resolves to nothing' : `matches only "${title}"`}:\n` +
          `      "${citation.text}"\n      (cited from: ${requirement.name})`,
      );
    }
}

for (const a of advisories) console.warn(`spec-crossrefs: REVIEW  ${a}`);
if (problems.length > 0) {
  for (const p of problems) console.error(`spec-crossrefs: FAIL    ${p}`);
  console.error(
    `\nspec-crossrefs: ${problems.length} dangling cross-reference(s). Quote the requirement's ` +
      `current title verbatim, or drop the citation — a pointer to a title nobody carries is a ` +
      `published contract that says "see nothing".`,
  );
  process.exit(1);
}
console.log(
  `spec-crossrefs: ok (${candidates} citation(s) across ${publishedSpecs.length} published ` +
    `capabilit${publishedSpecs.length === 1 ? 'y' : 'ies'}` +
    `${advisories.length > 0 ? `, ${advisories.length} item(s) to review` : ''})`,
);
