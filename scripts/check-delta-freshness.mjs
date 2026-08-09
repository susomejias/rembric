#!/usr/bin/env node
/**
 * Fails when an active OpenSpec change's `## MODIFIED Requirements` block is stale
 * against the published spec it will replace.
 *
 * `openspec archive` merges a MODIFIED block by REPLACING the whole requirement. So a
 * delta authored before another change archived silently reverts whatever that change
 * published — the scenario loss is loud (archive refuses), but a reverted body line is
 * not. This happened three times in one day while applying five changes in sequence,
 * and every instance was caught by running this comparison by hand rather than by
 * reading the diff.
 *
 * What it reports, per MODIFIED requirement:
 *   - a header that does not exist in the published spec (archive would ADD a second
 *     requirement instead of replacing one),
 *   - a published `#### Scenario:` title absent from the delta (archive refuses),
 *   - a published BODY line absent from the delta (archive reverts it, silently).
 *
 * The last is advisory by nature: a change may legitimately rewrite a line, which is
 * the whole point of MODIFIED. So body differences are reported for review rather than
 * failing the run unless `--strict-body` is passed. Missing headers and dropped
 * scenarios always fail — neither can be intentional.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const changesDir = join(repoRoot, 'openspec', 'changes');
const specsDir = join(repoRoot, 'openspec', 'specs');
const strictBody = process.argv.includes('--strict-body');

/** The requirement's slice of a spec document, header line included. */
function sliceRequirement(source, header) {
  const start = source.indexOf(header);
  if (start === -1) return null;
  const next = source.indexOf('\n### Requirement:', start + header.length);
  return source.slice(start, next === -1 ? source.length : next);
}

const scenarioTitles = (slice) =>
  [...slice.matchAll(/^#### Scenario: (.*)$/gm)].map((m) => m[1].trim());

/** Body = everything before the first scenario, blank lines dropped. */
const bodyLines = (slice) => {
  const cut = slice.indexOf('\n#### Scenario:');
  return (cut === -1 ? slice : slice.slice(0, cut))
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
};

function activeChanges() {
  if (!statSync(changesDir, { throwIfNoEntry: false })) return [];
  return readdirSync(changesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'archive')
    .map((e) => e.name);
}

const problems = [];
const advisories = [];

for (const change of activeChanges()) {
  const specRoot = join(changesDir, change, 'specs');
  if (!statSync(specRoot, { throwIfNoEntry: false })) continue;

  for (const capability of readdirSync(specRoot)) {
    const deltaPath = join(specRoot, capability, 'spec.md');
    if (!statSync(deltaPath, { throwIfNoEntry: false })) continue;
    const publishedPath = join(specsDir, capability, 'spec.md');
    // A capability with no published spec is being created, so nothing can be stale.
    if (!statSync(publishedPath, { throwIfNoEntry: false })) continue;

    const delta = readFileSync(deltaPath, 'utf8');
    const published = readFileSync(publishedPath, 'utf8');

    // `## RENAMED Requirements` is applied by `openspec archive` BEFORE the
    // MODIFIED merge, so a delta may legitimately carry a MODIFIED block under
    // a header the published spec does not have yet. Without this, the repo's
    // own documented rename mechanism fails this gate with a false positive.
    const renamedBlock = delta.split('## RENAMED Requirements')[1]?.split('\n## ')[0] ?? '';
    const renamedFrom = new Map();
    {
      let from = null;
      for (const line of renamedBlock.split('\n')) {
        const f = /^-\s*FROM:\s*`(### Requirement: .*)`\s*$/.exec(line);
        if (f) from = f[1];
        const t = /^-\s*TO:\s*`(### Requirement: .*)`\s*$/.exec(line);
        if (t && from) {
          renamedFrom.set(t[1], from);
          from = null;
        }
      }
    }

    const afterMarker = delta.split('## MODIFIED Requirements')[1];
    if (afterMarker === undefined) continue;
    const modifiedBlock = afterMarker.split('\n## ')[0];

    for (const [, name] of modifiedBlock.matchAll(/^### Requirement: (.*)$/gm)) {
      const header = `### Requirement: ${name}`;
      const publishedSlice = sliceRequirement(published, renamedFrom.get(header) ?? header);
      if (publishedSlice === null) {
        problems.push(
          `${change} / ${capability}: MODIFIED header not found in the published spec, so ` +
            `archive would ADD a second requirement rather than replace one:\n    ${name}`,
        );
        continue;
      }
      const deltaSlice = sliceRequirement(modifiedBlock, header);

      const dropped = scenarioTitles(publishedSlice).filter(
        (t) => !scenarioTitles(deltaSlice).includes(t),
      );
      if (dropped.length > 0) {
        problems.push(
          `${change} / ${capability} / ${name}: ${dropped.length} published scenario(s) ` +
            `absent from the delta — archive will refuse:\n` +
            dropped.map((t) => `      - ${t}`).join('\n'),
        );
      }

      const inDelta = new Set(bodyLines(deltaSlice));
      const reverted = bodyLines(publishedSlice).filter((l) => !inDelta.has(l));
      if (reverted.length > 0) {
        const detail =
          `${change} / ${capability} / ${name}: ${reverted.length} published body line(s) ` +
          `not present verbatim. Each must be a deliberate rewrite by this change; anything ` +
          `else is a silent revert of what another change published:\n` +
          reverted.map((l) => `      - ${l.slice(0, 120)}`).join('\n');
        (strictBody ? problems : advisories).push(detail);
      }
    }
  }
}

for (const a of advisories) console.warn(`delta-freshness: REVIEW  ${a}`);
if (problems.length > 0) {
  for (const p of problems) console.error(`delta-freshness: FAIL    ${p}`);
  console.error(
    `\ndelta-freshness: ${problems.length} blocking problem(s). Rebase the delta onto the ` +
      `published text: take the published requirement and re-apply only this change's edits.`,
  );
  process.exit(1);
}
console.log(
  `delta-freshness: ok (${activeChanges().length} active change(s)` +
    `${advisories.length > 0 ? `, ${advisories.length} body difference(s) to review` : ''})`,
);
