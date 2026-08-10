import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SECTIONS = join(SCRIPT_DIR, 'check-delta-sections.mjs');
const CROSSREFS = join(SCRIPT_DIR, 'check-spec-crossrefs.mjs');

const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A throwaway `openspec/` tree. The gates take `--root` precisely so a fixture can be
 * driven without writing anything into the real spec tree — a probe under
 * `openspec/changes/` would be picked up by the gates' own default run.
 */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'rembric-spec-gate-'));
  fixtures.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

const run = (script: string, root: string, ...args: string[]) => {
  const result = spawnSync(process.execPath, [script, '--root', root, ...args], {
    encoding: 'utf8',
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
};

const PUBLISHED_SESSIONS = `# sessions

## Purpose

Fixture.

## Requirements

### Requirement: A session summary MUST follow the documented structure

The summary SHALL carry the canonical sections.

#### Scenario: A summary is stored verbatim

- **WHEN** a summary is written
- **THEN** it SHALL be stored

### Requirement: An empty summary MUST be rejected

The tool-level rejection specified in this capability under "A session summary MUST follow the documented structure" is the same verdict.

#### Scenario: An empty summary is refused

- **WHEN** an empty summary is written
- **THEN** the call SHALL fail
`;

describe('check-delta-sections', () => {
  it('passes a delta whose requirements sit under the section that describes them', () => {
    const root = fixture({
      'openspec/specs/sessions/spec.md': PUBLISHED_SESSIONS,
      'openspec/changes/c/specs/sessions/spec.md': `## ADDED Requirements

### Requirement: A summary write MUST merge

Text.

#### Scenario: A write merges

- **WHEN** a second summary is written
- **THEN** it SHALL merge

## REMOVED Requirements

### Requirement: A session summary MUST follow the documented structure

**Reason**: replaced by the merging requirement above.

**Migration**: none.
`,
    });
    const { code, out } = run(SECTIONS, root);
    expect(out).toContain('delta-sections: ok');
    expect(code).toBe(0);
  });

  it('fails an additive requirement appended under REMOVED Requirements', () => {
    const root = fixture({
      'openspec/specs/sessions/spec.md': PUBLISHED_SESSIONS,
      'openspec/changes/c/specs/sessions/spec.md': `## REMOVED Requirements

### Requirement: A session summary MUST follow the documented structure

**Reason**: replaced.

**Migration**: none.

### Requirement: A curated summary write MUST merge into the stored summary

The server SHALL merge section-wise.

#### Scenario: An accumulating section keeps every stored line

- **WHEN** a second curated summary is written
- **THEN** no stored line SHALL be dropped
`,
    });
    const { code, err } = run(SECTIONS, root);
    expect(err).toContain('REMOVED requirement carries 1 `#### Scenario:` block(s)');
    expect(err).toContain('REMOVED requirement is absent from the published spec');
    expect(err).toContain('A curated summary write MUST merge into the stored summary');
    expect(code).toBe(1);
  });

  it('fails a requirement appended below a non-delta heading', () => {
    const root = fixture({
      'openspec/specs/sessions/spec.md': PUBLISHED_SESSIONS,
      'openspec/changes/c/specs/sessions/spec.md': `## ADDED Requirements

### Requirement: A summary write MUST merge

Text.

## Out-of-scope behaviors

Nothing.

### Requirement: A second summary rule MUST hold

Text.
`,
    });
    const { code, err } = run(SECTIONS, root);
    expect(err).toContain('sits under `## Out-of-scope behaviors`');
    expect(err).toContain('A second summary rule MUST hold');
    expect(code).toBe(1);
  });

  it('fails a MODIFIED filed as an ADDED, and exempts the remove-and-re-add refactor', () => {
    const misfiled = `## ADDED Requirements

### Requirement: A session summary MUST follow the documented structure

Rewritten text.
`;
    const refactor = `${misfiled}
## REMOVED Requirements

### Requirement: A session summary MUST follow the documented structure

**Reason**: re-published under the same title because a scenario title had to change.

**Migration**: none.
`;
    const misfiledRun = run(
      SECTIONS,
      fixture({
        'openspec/specs/sessions/spec.md': PUBLISHED_SESSIONS,
        'openspec/changes/c/specs/sessions/spec.md': misfiled,
      }),
    );
    expect(misfiledRun.err).toContain('ADDED requirement already exists in the published spec');
    expect(misfiledRun.code).toBe(1);

    const refactorRun = run(
      SECTIONS,
      fixture({
        'openspec/specs/sessions/spec.md': PUBLISHED_SESSIONS,
        'openspec/changes/c/specs/sessions/spec.md': refactor,
      }),
    );
    expect(refactorRun.out).toContain('delta-sections: ok');
    expect(refactorRun.err).toContain('one requirement title appears in 2 delta sections');
    expect(refactorRun.code).toBe(0);
  });

  it('fails a RENAMED FROM header the published spec does not carry', () => {
    const root = fixture({
      'openspec/specs/sessions/spec.md': PUBLISHED_SESSIONS,
      'openspec/changes/c/specs/sessions/spec.md': `## RENAMED Requirements

- FROM: \`### Requirement: A session summary MUST follow the structure\`
- TO: \`### Requirement: A session summary MUST carry a merge policy per section\`
`,
    });
    const { code, err } = run(SECTIONS, root);
    expect(err).toContain('RENAMED `FROM:` header is absent from the published spec');
    expect(code).toBe(1);
  });

  it('reports a removal with no Reason or Migration without failing, unless asked to', () => {
    const root = fixture({
      'openspec/specs/sessions/spec.md': PUBLISHED_SESSIONS,
      'openspec/changes/c/specs/sessions/spec.md': `## REMOVED Requirements

### Requirement: A session summary MUST follow the documented structure

**This requirement is retained** in spirit by the requirements that remain.
`,
    });
    const advisory = run(SECTIONS, root);
    expect(advisory.err).toContain('has no **Reason** and no **Migration** line');
    expect(advisory.code).toBe(0);
    expect(run(SECTIONS, root, '--strict-metadata').code).toBe(1);
  });

  it('does not flag any archived change in this repo', () => {
    const repoRoot = join(SCRIPT_DIR, '..');
    const { code, out } = run(SECTIONS, repoRoot, '--archive');
    expect(out).toContain('delta-sections: ok');
    expect(code).toBe(0);
  });
});

describe('check-spec-crossrefs', () => {
  it('passes a citation that quotes a published requirement title verbatim', () => {
    const { code, out } = run(
      CROSSREFS,
      fixture({ 'openspec/specs/sessions/spec.md': PUBLISHED_SESSIONS }),
    );
    expect(out).toContain('spec-crossrefs: ok (1 citation(s)');
    expect(code).toBe(0);
  });

  it('fails a published citation of a title no requirement carries', () => {
    const { code, err } = run(
      CROSSREFS,
      fixture({
        'openspec/specs/sessions/spec.md': PUBLISHED_SESSIONS.replace(
          '### Requirement: A session summary MUST follow the documented structure\n',
          '### Requirement: A session summary MUST carry a merge policy per section\n',
        ),
      }),
    );
    expect(err).toContain('cites a requirement title that no published requirement carries');
    expect(err).toContain('"A session summary MUST follow the documented structure"');
    expect(code).toBe(1);
  });

  it('reports a truncated citation without failing, because a human still resolves it', () => {
    const { code, err, out } = run(
      CROSSREFS,
      fixture({
        'openspec/specs/sessions/spec.md': PUBLISHED_SESSIONS.replace(
          '### Requirement: A session summary MUST follow the documented structure\n\nThe summary',
          '### Requirement: A session summary MUST follow the documented structure and cadence\n\nThe summary',
        ),
      }),
    );
    expect(err).toContain("citation is not the requirement's full title");
    expect(out).toContain('spec-crossrefs: ok');
    expect(code).toBe(0);
  });

  it('reports a citation that an active change is about to break, without failing', () => {
    const { code, err, out } = run(
      CROSSREFS,
      fixture({
        'openspec/specs/sessions/spec.md': PUBLISHED_SESSIONS,
        'openspec/changes/c/specs/sessions/spec.md': `## ADDED Requirements

### Requirement: A session summary MUST carry a merge policy per section

Text.

## REMOVED Requirements

### Requirement: A session summary MUST follow the documented structure

**Reason**: replaced by the requirement above.

**Migration**: none.
`,
      }),
    );
    expect(err).toContain('after the active change(s) archive, this citation resolves to nothing');
    expect(err).toContain('"A session summary MUST follow the documented structure"');
    expect(out).toContain('spec-crossrefs: ok');
    expect(code).toBe(0);
  });

  it('does not report a removal Reason for naming the requirement it removes', () => {
    const { code, err } = run(
      CROSSREFS,
      fixture({
        'openspec/specs/sessions/spec.md': PUBLISHED_SESSIONS,
        'openspec/changes/c/specs/sessions/spec.md': `## REMOVED Requirements

### Requirement: A session summary MUST follow the documented structure

**Reason**: the central clause of "A session summary MUST follow the documented structure" is overturned.

**Migration**: none.
`,
      }),
    );
    expect(err).not.toContain('openspec/changes/c/specs/sessions/spec.md');
    expect(code).toBe(0);
  });

  it('ignores a modal-free quoted phrase rather than guessing it is a citation', () => {
    const { code, out } = run(
      CROSSREFS,
      fixture({
        'openspec/specs/sessions/spec.md': `# sessions

## Requirements

### Requirement: The reaper MUST retire stale sessions

The cascade defined in "Slug resolution cascade order" applies, and the row is marked "abandoned".

#### Scenario: A stale session is retired

- **WHEN** the sweep runs
- **THEN** the row SHALL be abandoned
`,
      }),
    );
    expect(out).toContain('spec-crossrefs: ok (0 citation(s)');
    expect(code).toBe(0);
  });
});
