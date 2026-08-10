#!/usr/bin/env node
/**
 * Fails when a requirement in an active OpenSpec change sits under a delta section
 * that does not describe what the change actually does to it.
 *
 * `openspec archive` dispatches on the enclosing `## ` heading and nothing else. A
 * requirement appended to the END of a delta file therefore lands under whichever
 * `## ` heading happens to be last, and every existing gate passes: `openspec
 * validate --strict` only checks shape, `check-delta-freshness` only reads the
 * `## MODIFIED Requirements` block, `check-spec-provenance` only checks that a
 * published-spec edit came through a change folder, and no test parses requirement
 * text. This happened twice in one session. The MODIFIED landing was caught (by
 * delta-freshness, because the header was absent from the published spec); the
 * REMOVED landing was caught by nothing — a 68-line, 7-scenario additive
 * requirement sat under `## REMOVED Requirements`, where archive would have
 * processed it as the removal of a requirement the published spec never had: a
 * silent no-op that deletes the whole contract with no error and no diff.
 *
 * BLOCKING rules (each verified to flag zero of the 387 delta files / 508 ADDED /
 * 33 REMOVED requirements under `openspec/changes/archive/`):
 *
 *   1. A `### Requirement:` that is not inside one of the four delta sections
 *      (ADDED / MODIFIED / REMOVED / RENAMED). This is the append-at-the-end
 *      failure in its purest form — archive ignores such a requirement entirely.
 *   2. A REMOVED requirement carrying `#### Scenario:` blocks. A removal states a
 *      Reason and a Migration; it does not re-specify behaviour. Zero of the 33
 *      historical removals carry a scenario, so a scenario there is a misfiled
 *      ADDED or MODIFIED.
 *   3. A REMOVED requirement whose header is absent from the published spec. You
 *      cannot remove what was never published; archive would no-op.
 *   4. An ADDED requirement whose header already exists in the published spec —
 *      a MODIFIED wearing the wrong hat; archive would publish a duplicate.
 *      Exempt when the same delta also REMOVEs that title or RENAMEs away from
 *      it, which is the documented remove-and-re-add refactor.
 *   5. A RENAMED `FROM:` header absent from the published spec. `check-delta-freshness`
 *      trusts the RENAMED block to excuse a MODIFIED header the published spec lacks,
 *      so a wrong FROM silently disables that gate as well as this one.
 *   6. One requirement title in two different delta sections of the same file. The
 *      REMOVED+ADDED pair is the legitimate refactor and is reported as advisory
 *      instead; every other pairing is contradictory.
 *
 * ADVISORY (reported, does not fail unless `--strict-metadata`):
 *
 *   - A REMOVED requirement missing a `**Reason…**` or `**Migration…**` line. This is
 *     the repo's convention for a real removal and its absence is evidence of
 *     misfiling, but the archive holds legitimate counter-examples: 1 of 33 removals
 *     states its rationale in prose without the bold label
 *     (`2026-05-14-convergent-saves-and-synchronous-judgment`, "**This requirement is
 *     retained** in spirit"), and 5 of 33 omit Migration because a pure spec-text
 *     refactor migrates nothing. Blocking on either would fire on correct history.
 *
 * DELIBERATELY NOT ATTEMPTED: rules 3–6 compare against the CURRENT published spec,
 * which is only meaningful for an unarchived change. Running them over
 * `openspec/changes/archive/` would invert every verdict — an archived REMOVED is
 * legitimately absent from the published spec because the merge already applied, and
 * an archived ADDED is legitimately present. `--archive` therefore replays only the
 * self-contained rules (1, 2, 6 and the advisory) over the archive, which is what
 * grounded them; reconstructing each archived change's pre-merge published spec from
 * git history is out of scope for a working-tree gate.
 *
 * Flags: `--archive` (replay over `openspec/changes/archive/`), `--strict-metadata`
 * (promote the advisory to blocking), `--root <dir>` (point at a fixture tree instead
 * of this repo — how the co-located test drives it).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootFlag = process.argv.indexOf('--root');
const repoRoot =
  rootFlag === -1
    ? join(dirname(fileURLToPath(import.meta.url)), '..')
    : process.argv[rootFlag + 1];
const changesDir = join(repoRoot, 'openspec', 'changes');
const specsDir = join(repoRoot, 'openspec', 'specs');
const archiveMode = process.argv.includes('--archive');
const strictMetadata = process.argv.includes('--strict-metadata');

const DELTA_SECTIONS = new Set([
  'ADDED Requirements',
  'MODIFIED Requirements',
  'REMOVED Requirements',
  'RENAMED Requirements',
]);

/**
 * Splits a spec document into `## ` sections, each holding its `### Requirement:`
 * entries. Fenced blocks are skipped: a spec may quote markdown, and a `## ` inside a
 * fence is not a heading.
 */
function parse(source) {
  const sections = [{ name: null, requirements: [], lines: [] }];
  let fence = null;
  let requirement = null;
  source.split('\n').forEach((line, i) => {
    const fenceMark = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMark) {
      if (fence === null) fence = fenceMark[1][0];
      else if (fenceMark[1][0] === fence) fence = null;
      return;
    }
    if (fence !== null) return;

    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      sections.push({ name: heading[1].trim(), requirements: [], lines: [] });
      requirement = null;
      return;
    }
    const section = sections[sections.length - 1];
    section.lines.push(line);

    const req = /^### Requirement: (.*)$/.exec(line);
    if (req) {
      requirement = { name: req[1].trim(), line: i + 1, lines: [] };
      section.requirements.push(requirement);
      return;
    }
    if (requirement) requirement.lines.push(line);
  });
  return sections;
}

const publishedTitles = (capability) => {
  const path = join(specsDir, capability, 'spec.md');
  if (!statSync(path, { throwIfNoEntry: false })) return null;
  return new Set(
    parse(readFileSync(path, 'utf8')).flatMap((s) => s.requirements.map((r) => r.name)),
  );
};

/** `- FROM: \`### Requirement: X\`` / `- TO: …` pairs, in the order they appear. */
function renamePairs(section) {
  const pairs = [];
  let from = null;
  for (const line of section.lines) {
    const f = /^-\s*FROM:\s*`### Requirement: (.*)`\s*$/.exec(line);
    if (f) from = f[1].trim();
    const t = /^-\s*TO:\s*`### Requirement: (.*)`\s*$/.exec(line);
    if (t && from !== null) {
      pairs.push({ from, to: t[1].trim() });
      from = null;
    }
  }
  return pairs;
}

function changeDirs() {
  if (!statSync(changesDir, { throwIfNoEntry: false })) return [];
  const entries = (dir) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  if (archiveMode) {
    const archive = join(changesDir, 'archive');
    if (!statSync(archive, { throwIfNoEntry: false })) return [];
    return entries(archive).map((name) => ({ name, root: join(archive, name) }));
  }
  return entries(changesDir)
    .filter((name) => name !== 'archive')
    .map((name) => ({ name, root: join(changesDir, name) }));
}

const problems = [];
const advisories = [];
let filesScanned = 0;

for (const change of changeDirs()) {
  const specRoot = join(change.root, 'specs');
  if (!statSync(specRoot, { throwIfNoEntry: false })) continue;

  for (const capability of readdirSync(specRoot)) {
    const deltaPath = join(specRoot, capability, 'spec.md');
    if (!statSync(deltaPath, { throwIfNoEntry: false })) continue;
    filesScanned += 1;

    const where = `${change.name} / ${capability}`;
    const sections = parse(readFileSync(deltaPath, 'utf8'));
    const published = archiveMode ? null : publishedTitles(capability);

    const byName = new Map();
    for (const section of sections) {
      for (const requirement of section.requirements) {
        if (!DELTA_SECTIONS.has(section.name ?? '')) {
          problems.push(
            `${where}:${requirement.line}: requirement sits under ` +
              `${section.name === null ? 'no `## ` heading at all' : `\`## ${section.name}\``} ` +
              `rather than a delta section, so \`openspec archive\` will ignore it entirely:\n` +
              `      ${requirement.name}`,
          );
          continue;
        }
        const seen = byName.get(requirement.name);
        if (seen) seen.push(section.name);
        else byName.set(requirement.name, [section.name]);
      }
    }

    for (const [name, sectionNames] of byName) {
      if (sectionNames.length < 2) continue;
      const pair = [...sectionNames].sort().join(' + ');
      const detail =
        `${where}: one requirement title appears in ${sectionNames.length} delta sections ` +
        `(${sectionNames.map((s) => `\`## ${s}\``).join(', ')}):\n      ${name}`;
      // Remove-then-re-add under the SAME title is the documented refactor when a
      // published scenario title has to change; every other pairing contradicts itself.
      if (pair === 'ADDED Requirements + REMOVED Requirements') advisories.push(detail);
      else problems.push(detail);
    }

    for (const section of sections) {
      if (section.name === 'REMOVED Requirements') {
        for (const requirement of section.requirements) {
          const body = requirement.lines.join('\n');
          const scenarios = [...body.matchAll(/^#### Scenario: (.*)$/gm)].map((m) => m[1].trim());
          if (scenarios.length > 0) {
            problems.push(
              `${where}:${requirement.line}: REMOVED requirement carries ${scenarios.length} ` +
                `\`#### Scenario:\` block(s). A removal states a Reason and a Migration; it does ` +
                `not re-specify behaviour — this is a misfiled ADDED or MODIFIED:\n` +
                `      ${requirement.name}\n` +
                scenarios.map((s) => `        - ${s}`).join('\n'),
            );
          }
          const missing = [
            /^\*\*Reason\b/im.test(body) ? null : '**Reason**',
            /^\*\*Migration\b/im.test(body) ? null : '**Migration**',
          ].filter((m) => m !== null);
          if (missing.length > 0) {
            const detail =
              `${where}:${requirement.line}: REMOVED requirement has no ${missing.join(' and no ')} ` +
              `line, the repo's convention for a real removal:\n      ${requirement.name}`;
            (strictMetadata ? problems : advisories).push(detail);
          }
          if (published !== null && !published.has(requirement.name)) {
            problems.push(
              `${where}:${requirement.line}: REMOVED requirement is absent from the published ` +
                `spec, so archive would no-op and the block would vanish without a trace:\n` +
                `      ${requirement.name}`,
            );
          }
        }
      }

      if (section.name === 'ADDED Requirements' && published !== null) {
        const removedHere = new Set(
          sections
            .filter((s) => s.name === 'REMOVED Requirements')
            .flatMap((s) => s.requirements.map((r) => r.name)),
        );
        for (const { from } of sections
          .filter((s) => s.name === 'RENAMED Requirements')
          .flatMap(renamePairs))
          removedHere.add(from);
        for (const requirement of section.requirements) {
          if (!published.has(requirement.name) || removedHere.has(requirement.name)) continue;
          problems.push(
            `${where}:${requirement.line}: ADDED requirement already exists in the published ` +
              `spec, so archive would publish a duplicate. This is a MODIFIED (or a REMOVED+ADDED ` +
              `pair) filed as an ADDED:\n      ${requirement.name}`,
          );
        }
      }

      if (section.name === 'RENAMED Requirements' && published !== null) {
        for (const { from, to } of renamePairs(section)) {
          if (published.has(from)) continue;
          problems.push(
            `${where}: RENAMED \`FROM:\` header is absent from the published spec, which also ` +
              `disables the rename exemption \`check-delta-freshness\` grants:\n` +
              `      FROM: ${from}\n      TO:   ${to}`,
          );
        }
      }
    }
  }
}

for (const a of advisories) console.warn(`delta-sections: REVIEW  ${a}`);
if (problems.length > 0) {
  for (const p of problems) console.error(`delta-sections: FAIL    ${p}`);
  console.error(
    `\ndelta-sections: ${problems.length} blocking problem(s). Move each requirement under the ` +
      `\`## \` heading that names what this change does to it — archive dispatches on that ` +
      `heading and on nothing else.`,
  );
  process.exit(1);
}
console.log(
  `delta-sections: ok (${filesScanned} delta file(s)` +
    `${archiveMode ? ' in the archive, self-contained rules only' : ''}` +
    `${advisories.length > 0 ? `, ${advisories.length} item(s) to review` : ''})`,
);
