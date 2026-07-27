#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PUBLISHED_SPEC_RE = /^openspec\/specs\/([^/]+)\/spec\.md$/;
const ARCHIVE_DELTA_RE = /^openspec\/changes\/archive\/[^/]+\/specs\/([^/]+)\/spec\.md$/;
const ARCHIVE_PREFIX = 'openspec/changes/archive/';
// Anchored with no leading whitespace and matched against the LAST paragraph
// only, so prose describing this feature cannot waive a range — the skill text
// and this script's own error output both print the literal key. The reason must
// carry more than a placeholder.
const EXEMPT_TRAILER_RE = /^Spec-Provenance-Exempt:[ \t]*(\S.*?)[ \t]*$/m;
const PLACEHOLDER_REASON_RE = /^(?:[-.]|n\/?a|none|tbd|todo|\?+)$/i;
const UNRESOLVABLE_SHA_RE = /^0+$/;

export function parseNameStatus(stdout) {
  const entries = [];
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const fields = line.split('\t');
    const status = fields[0]?.[0];
    if (!status) continue;
    // R/C carry a similarity score and a second path: `R096\told\tnew`.
    if (status === 'R' || status === 'C') {
      if (fields.length < 3) continue;
      entries.push({ status, path: fields[1], newPath: fields[2] });
    } else {
      if (fields.length < 2) continue;
      entries.push({ status, path: fields[1] });
    }
  }
  return entries;
}

function pathsOf(entry) {
  return entry.newPath ? [entry.path, entry.newPath] : [entry.path];
}

export function affectedSpecPaths(entries) {
  const paths = new Set();
  for (const entry of entries) {
    for (const p of pathsOf(entry)) {
      if (PUBLISHED_SPEC_RE.test(p)) paths.add(p);
    }
  }
  return [...paths].sort();
}

export function affectedCapabilities(entries) {
  const caps = new Set();
  for (const p of affectedSpecPaths(entries)) {
    caps.add(PUBLISHED_SPEC_RE.exec(p)[1]);
  }
  return [...caps].sort();
}

// An addition, or a rename into the archive from OUTSIDE it. Both exclusions are
// laundering routes that were reachable in one command: a rename whose source is
// a published spec proved its own provenance while deleting the contract, and a
// rename within the archive (correcting a date prefix) paired every capability
// the old folder happened to carry.
function archiveArrivals(entries) {
  const arrivals = [];
  for (const entry of entries) {
    if (entry.status === 'A') {
      if (entry.path.startsWith(ARCHIVE_PREFIX)) arrivals.push(entry.path);
    } else if (entry.status === 'R' || entry.status === 'C') {
      const from = entry.path;
      const arrivedFromOutside = !from.startsWith(ARCHIVE_PREFIX) && !PUBLISHED_SPEC_RE.test(from);
      if (entry.newPath.startsWith(ARCHIVE_PREFIX) && arrivedFromOutside) {
        arrivals.push(entry.newPath);
      }
    }
  }
  return arrivals;
}

export function hasArchiveArrival(entries) {
  return archiveArrivals(entries).length > 0;
}

export function pairedCapabilities(entries) {
  const caps = new Set();
  for (const p of archiveArrivals(entries)) {
    const match = ARCHIVE_DELTA_RE.exec(p);
    if (match) caps.add(match[1]);
  }
  return [...caps].sort();
}

export function findExemption(trailers = []) {
  for (const text of trailers) {
    const paragraphs = (text ?? '').trimEnd().split(/\n\s*\n/);
    const last = paragraphs[paragraphs.length - 1] ?? '';
    const match = EXEMPT_TRAILER_RE.exec(last);
    if (match && !PLACEHOLDER_REASON_RE.test(match[1])) return match[1];
  }
  return null;
}

export function checkProvenance(entries, { trailers = [] } = {}) {
  const affected = affectedCapabilities(entries);
  const paired = new Set(pairedCapabilities(entries));
  const archived = hasArchiveArrival(entries);

  const violations = affected
    .filter((capability) => !archived || !paired.has(capability))
    .map((capability) => ({
      capability,
      expectedPath: `openspec/changes/archive/<YYYY-MM-DD-change>/specs/${capability}/spec.md`,
    }));

  if (violations.length === 0) return { ok: true, violations: [], exempt: null };

  const reason = findExemption(trailers);
  if (reason !== null) {
    return { ok: true, violations: [], exempt: { reason, waived: affectedSpecPaths(entries) } };
  }
  return { ok: false, violations, exempt: null };
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function resolveRange(base, head, cwd) {
  if (UNRESOLVABLE_SHA_RE.test(base))
    return { ok: false, reason: `base "${base}" is the null SHA` };
  for (const ref of [base, head]) {
    try {
      git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
    } catch {
      return { ok: false, reason: `ref "${ref}" does not resolve` };
    }
  }
  // `base...head` diffs from the merge base, so ancestry is NOT required — a PR
  // whose base branch advanced must still be checked. Only a missing merge base
  // (unrelated histories) makes the range unresolvable.
  try {
    git(['merge-base', base, head], cwd);
  } catch {
    return { ok: false, reason: `"${base}" and "${head}" share no merge base` };
  }
  return { ok: true };
}

export function gitDiffEntries(base, head, cwd) {
  return parseNameStatus(
    // core.quotepath=false, or git octal-escapes non-ASCII paths and wraps them
    // in quotes, which defeats the leading-anchor in both path regexes.
    git(
      [
        '-c',
        'core.quotepath=false',
        'diff',
        '--name-status',
        '--find-renames',
        `${base}...${head}`,
      ],
      cwd,
    ),
  );
}

export function gitTrailers(base, head, cwd) {
  const log = git(['log', '--format=%B%x00', `${base}..${head}`], cwd);
  return log.split('\0').filter((message) => message.trim() !== '');
}

function main(argv) {
  let base = 'main';
  let head = 'HEAD';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base') base = argv[++i];
    else if (argv[i] === '--head') head = argv[++i];
    else if (argv[i].startsWith('--base=')) base = argv[i].slice('--base='.length);
    else if (argv[i].startsWith('--head=')) head = argv[i].slice('--head='.length);
    else {
      console.error(`spec-provenance: unknown argument "${argv[i]}"`);
      return 2;
    }
  }

  const range = resolveRange(base, head, process.cwd());
  if (!range.ok) {
    // ::warning:: so a permanently-skipping gate is visible rather than reading
    // as a pass. A force-push to main leaves `before` unreachable and lands here.
    console.log(`::warning::spec-provenance: range unresolvable, skipping — ${range.reason}`);
    return 0;
  }

  const entries = gitDiffEntries(base, head, process.cwd());
  const result = checkProvenance(entries, { trailers: gitTrailers(base, head, process.cwd()) });

  if (result.exempt) {
    console.log(`spec-provenance: exempted by trailer — ${result.exempt.reason}`);
    for (const path of result.exempt.waived) console.log(`  waived: ${path}`);
    return 0;
  }
  if (result.ok) {
    console.log(`spec-provenance: ok (${base}...${head})`);
    return 0;
  }

  console.log(
    '::error::spec-provenance: a published spec changed without an archived change folder in the same diff.',
  );
  for (const { capability, expectedPath } of result.violations) {
    console.log(`  ${capability}: openspec/specs/${capability}/spec.md has no paired archive`);
    console.log(`    expected an added or renamed ${expectedPath}`);
  }
  console.log(
    'Published spec text must arrive by archiving a change folder (delta sync + move into',
  );
  console.log('openspec/changes/archive/ in one commit). To record a deliberate exception, add a');
  console.log('"Spec-Provenance-Exempt: <reason>" trailer to a commit in this diff.');
  return 1;
}

// pathToFileURL, not string concatenation: `import.meta.url` is percent-encoded
// and realpath-resolved, so a clone under a path with a space silently skipped
// main() and exited 0 with no output — indistinguishable from a pass.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(main(process.argv.slice(2)));
}
