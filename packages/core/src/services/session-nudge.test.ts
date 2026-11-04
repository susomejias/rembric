import { describe, expect, it } from 'vitest';

import { SUMMARY_MAX_CHARS } from '@rembric/core';
import {
  composeSaveClause,
  composeSessionNotice,
  evaluateSessionNudge,
  NOTICE_MAX_BYTES,
  type SessionNudgeRow,
} from '@rembric/core';

const FLOOR_MS = 25 * 60_000;
const STARTED = new Date('2026-01-01T00:00:00.000Z');

function row(overrides: Partial<SessionNudgeRow> = {}): SessionNudgeRow {
  return {
    startedAt: STARTED,
    activityStartedAt: null,
    lastSummaryAt: null,
    lastNudgeAt: null,
    lastWorkAt: null,
    lastMemoryAt: null,
    summary: null,
    title: 'a session',
    ...overrides,
  };
}

function minutesAfter(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

describe('evaluateSessionNudge — the gate', () => {
  it('never fires without a completed report activity anchor', () => {
    expect(
      evaluateSessionNudge(row(), minutesAfter(STARTED, 60), FLOOR_MS, SUMMARY_MAX_CHARS),
    ).toBeNull();
  });

  it('fires when activity followed a null summary, past the floor', () => {
    const r = row({ activityStartedAt: minutesAfter(STARTED, 30) });
    expect(
      evaluateSessionNudge(r, minutesAfter(STARTED, 40), FLOOR_MS, SUMMARY_MAX_CHARS),
    ).not.toBeNull();
  });

  it('does not fire when the summary is no older than the activity', () => {
    const writtenAt = minutesAfter(STARTED, 30);
    for (const lastSummaryAt of [writtenAt, minutesAfter(STARTED, 35)]) {
      expect(
        evaluateSessionNudge(
          row({ activityStartedAt: writtenAt, lastSummaryAt }),
          minutesAfter(STARTED, 60),
          FLOOR_MS,
          SUMMARY_MAX_CHARS,
        ),
      ).toBeNull();
    }
  });

  it('fires again once further activity follows the summary write', () => {
    const r = row({
      activityStartedAt: minutesAfter(STARTED, 60),
      lastSummaryAt: minutesAfter(STARTED, 35),
    });
    expect(
      evaluateSessionNudge(r, minutesAfter(STARTED, 90), FLOOR_MS, SUMMARY_MAX_CHARS),
    ).not.toBeNull();
  });

  it('fires exactly at the first floor, not one millisecond before', () => {
    const r = row({ activityStartedAt: STARTED });
    expect(
      evaluateSessionNudge(
        r,
        new Date(STARTED.getTime() + FLOOR_MS - 1),
        FLOOR_MS,
        SUMMARY_MAX_CHARS,
      ),
    ).toBeNull();
    expect(
      evaluateSessionNudge(r, new Date(STARTED.getTime() + FLOOR_MS), FLOOR_MS, SUMMARY_MAX_CHARS),
    ).not.toBeNull();
  });

  it('is not repeated inside the floor after a notice was emitted', () => {
    const nudgedAt = minutesAfter(STARTED, 30);
    const r = row({ activityStartedAt: nudgedAt, lastNudgeAt: nudgedAt });
    expect(
      evaluateSessionNudge(
        r,
        new Date(nudgedAt.getTime() + FLOOR_MS - 1),
        FLOOR_MS,
        SUMMARY_MAX_CHARS,
      ),
    ).toBeNull();
    expect(
      evaluateSessionNudge(r, new Date(nudgedAt.getTime() + FLOOR_MS), FLOOR_MS, SUMMARY_MAX_CHARS),
    ).not.toBeNull();
  });
});

describe('composeSessionNotice', () => {
  it('states the merge rule without re-deriving it, and licenses not calling', () => {
    const text = composeSessionNotice(
      row({ summary: '## Goal\nship it', title: 'demo' }),
      SUMMARY_MAX_CHARS,
    );
    expect(text).toContain('##');
    expect(text).toMatch(/omit/i);
    expect(text).toMatch(/do not call/i);
    expect(text).not.toMatch(/this turn/i);
    expect(text).not.toMatch(/current context window/i);
    expect(text).not.toMatch(/since the last write/i);
  });

  it('names current sizes and the total against the cap for a six-section summary', () => {
    const summary = [
      '## Goal',
      'ship the thing',
      '## Accomplished',
      'shipped part of it',
      '## Decisions+why',
      'chose X because Y',
      '## Verified+how',
      'ran the tests',
      '## Unfinished+why',
      'left the docs',
      '## Files',
      'a.ts, b.ts',
    ].join('\n');
    const text = composeSessionNotice(row({ summary, title: 'my session' }), SUMMARY_MAX_CHARS);
    expect(text).toContain('my session');
    expect(text).toContain('## Goal');
    expect(text).toContain('## Files');
    expect(text).toMatch(/current sizes, not targets/);
    expect(text).toMatch(new RegExp(`${summary.length} used of ${SUMMARY_MAX_CHARS} available\\.`));
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(NOTICE_MAX_BYTES);
  });

  it('replaces the inventory with the canonical section list when nothing is stored', () => {
    const text = composeSessionNotice(row({ summary: null, title: 'fresh' }), SUMMARY_MAX_CHARS);
    expect(text).toContain('## Goal');
    expect(text).toContain('## Accomplished');
    expect(text).toContain('## Decisions+why');
    expect(text).toContain('## Verified+how');
    expect(text).toContain('## Unfinished+why');
    expect(text).toContain('## Files');
    expect(text).toContain('0 used of');
  });

  it('stays within the byte bound with nothing stored and a 100-code-unit CJK title', () => {
    const text = composeSessionNotice(
      row({ summary: null, title: '漢'.repeat(100) }),
      SUMMARY_MAX_CHARS,
    );
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(NOTICE_MAX_BYTES);
    expect(text).toContain('## Goal');
    expect(text).toContain('0 used of');
  });

  it('cuts a nothing-stored title without leaving a lone surrogate', () => {
    const text = composeSessionNotice(
      row({ summary: null, title: `x${'😀'.repeat(50)}` }),
      SUMMARY_MAX_CHARS,
    );
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(NOTICE_MAX_BYTES);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('a summary with no ## heading is treated as nothing stored', () => {
    const text = composeSessionNotice(
      row({ summary: 'just some prose, no headings', title: 't' }),
      SUMMARY_MAX_CHARS,
    );
    expect(text).toContain('## Goal');
  });

  it('never leaves a lone surrogate when the heading cut lands inside an emoji', () => {
    const heading = `## ${'a'.repeat(28)}😀 and more heading text`;
    const text = composeSessionNotice(
      row({ summary: `${heading}\nbody`, title: 't' }),
      SUMMARY_MAX_CHARS,
    );
    expect(text).toContain(`## ${'a'.repeat(28)} (`);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('stays within the byte bound with sections stored and a 100-code-unit CJK title', () => {
    const text = composeSessionNotice(
      row({ summary: '## Goal\nship it', title: '漢'.repeat(100) }),
      SUMMARY_MAX_CHARS,
    );
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(NOTICE_MAX_BYTES);
  });

  it('stays within the byte bound with sections stored and an unbounded placeholder title', () => {
    const title = `${'deep-directory-name'.repeat(21)} · 09:41 UTC`;
    const text = composeSessionNotice(
      row({ summary: '## Goal\nship it', title }),
      SUMMARY_MAX_CHARS,
    );
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(NOTICE_MAX_BYTES);
  });

  it('stays within the byte bound when a long title forces the every-section-elided return', () => {
    const sections: string[] = [];
    for (let i = 0; i < 40; i++) sections.push(`## Section ${i}`, `body ${i}`);
    const text = composeSessionNotice(
      row({ summary: sections.join('\n'), title: 'a'.repeat(1000) }),
      SUMMARY_MAX_CHARS,
    );
    expect(text).toMatch(/\+40 more/);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(NOTICE_MAX_BYTES);
  });

  it('a pathological forty-section, 100-char-heading summary stays within the byte bound and keeps ## Goal', () => {
    const sections: string[] = [];
    for (let i = 0; i < 40; i++) {
      const heading =
        i === 0
          ? '## Goal'
          : `## Section number ${i} with an extremely long heading name`.padEnd(90, 'x');
      sections.push(heading, `body text for section ${i}`);
    }
    const summary = sections.join('\n');
    const text = composeSessionNotice(row({ summary, title: 'pathological' }), SUMMARY_MAX_CHARS);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(NOTICE_MAX_BYTES);
    expect(text).toContain('## Goal');
    expect(text).toMatch(/\+\d+ more/);
  });
});

const SAVE_DIRECTIVE = '`memory.save`';
const SUMMARY_DIRECTIVE = '`memory.session_summary`';

function notice(r: SessionNudgeRow, now: Date): string | null {
  const lines = evaluateSessionNudge(r, now, FLOOR_MS, SUMMARY_MAX_CHARS);
  return lines === null ? null : lines.join('\n');
}

describe('evaluateSessionNudge — the save clause', () => {
  const sixSections =
    '## Goal\na\n## Accomplished\nb\n## Decisions+why\nc\n## Verified+how\nd\n## Unfinished+why\ne\n## Files\nf';

  it('asks to save when tool work followed the last memory, even with the summary fresh', () => {
    const text = notice(
      row({
        activityStartedAt: minutesAfter(STARTED, 30),
        lastSummaryAt: minutesAfter(STARTED, 40),
        lastWorkAt: minutesAfter(STARTED, 30),
        lastMemoryAt: minutesAfter(STARTED, 10),
        summary: sixSections,
      }),
      minutesAfter(STARTED, 60),
    );
    expect(text).toContain(SAVE_DIRECTIVE);
    expect(text).toContain('50 min without a `memory.save`');
    expect(text).not.toContain(SUMMARY_DIRECTIVE);
  });

  it('measures from the session start when nothing was ever saved', () => {
    const text = notice(
      row({ lastWorkAt: minutesAfter(STARTED, 100), lastSummaryAt: minutesAfter(STARTED, 120) }),
      minutesAfter(STARTED, 125),
    );
    expect(text).toContain('2h 05m without a `memory.save`');
  });

  it('does not ask to save when a memory was written no earlier than the last work', () => {
    const workAt = minutesAfter(STARTED, 30);
    for (const lastMemoryAt of [workAt, minutesAfter(STARTED, 35)]) {
      expect(
        notice(
          row({ lastWorkAt: workAt, lastMemoryAt, lastSummaryAt: minutesAfter(STARTED, 40) }),
          minutesAfter(STARTED, 60),
        ),
      ).toBeNull();
    }
  });

  it('never asks to save on a session that reported no tool work', () => {
    const text = notice(
      row({ activityStartedAt: minutesAfter(STARTED, 30), lastWorkAt: null }),
      minutesAfter(STARTED, 60),
    );
    expect(text).toContain(SUMMARY_DIRECTIVE);
    expect(text).not.toContain(SAVE_DIRECTIVE);
  });

  it('an ignored save clause is not repeated without further tool work', () => {
    const nudgedAt = minutesAfter(STARTED, 30);
    const r = row({
      lastWorkAt: minutesAfter(STARTED, 29),
      lastSummaryAt: minutesAfter(STARTED, 50),
      lastNudgeAt: nudgedAt,
    });
    expect(notice(r, minutesAfter(STARTED, 120))).toBeNull();
  });

  it('tool work in the turn that read the clause re-arms it', () => {
    const nudgedAt = minutesAfter(STARTED, 30);
    const r = row({
      lastWorkAt: nudgedAt,
      lastSummaryAt: minutesAfter(STARTED, 50),
      lastNudgeAt: nudgedAt,
    });
    expect(notice(r, minutesAfter(STARTED, 120))).toContain(SAVE_DIRECTIVE);
  });

  it('shares the one floor: no save clause inside it, one exactly at it', () => {
    const nudgedAt = minutesAfter(STARTED, 30);
    const r = row({
      lastWorkAt: minutesAfter(STARTED, 40),
      lastSummaryAt: minutesAfter(STARTED, 50),
      lastNudgeAt: nudgedAt,
    });
    expect(notice(r, new Date(nudgedAt.getTime() + FLOOR_MS - 1))).toBeNull();
    expect(notice(r, new Date(nudgedAt.getTime() + FLOOR_MS))).toContain(SAVE_DIRECTIVE);
  });

  it('puts the save clause first and keeps the summary notice byte-identical after it', () => {
    const r = row({
      activityStartedAt: minutesAfter(STARTED, 30),
      lastWorkAt: minutesAfter(STARTED, 30),
      summary: sixSections,
      title: 'demo',
    });
    const text = notice(r, minutesAfter(STARTED, 60))!;
    const [first, ...rest] = text.split('\n');
    expect(first).toBe(composeSaveClause(60 * 60_000));
    expect(rest.join('\n')).toBe(composeSessionNotice(r, SUMMARY_MAX_CHARS));
  });

  it('claims nothing about content: it asks a question and licenses skipping', () => {
    const clause = composeSaveClause(47 * 60_000);
    expect(clause).toMatch(/\?/);
    expect(clause).toMatch(/nothing durable\? skip/i);
    expect(clause).not.toMatch(/you (made|found|fixed)|worth saving happened/i);
  });

  it('formats the elapsed time in minutes below an hour and h/mm above', () => {
    expect(composeSaveClause(0)).toContain('0 min without');
    expect(composeSaveClause(59 * 60_000 + 59_999)).toContain('59 min without');
    expect(composeSaveClause(60 * 60_000)).toContain('1h 00m without');
    expect(composeSaveClause(26 * 3_600_000 + 7 * 60_000)).toContain('26h 07m without');
  });
});

describe('composeSessionNotice — with the save clause inside the byte bound', () => {
  const lead = composeSaveClause(999 * 3_600_000);

  it.each([
    ['nothing stored, 100-code-unit CJK title', null, '漢'.repeat(100)],
    ['nothing stored, emoji title', null, `x${'😀'.repeat(50)}`],
    ['one section, unbounded placeholder title', '## Goal\nship it', 'x'.repeat(1000)],
  ])('%s keeps the whole clause and stays within the bound', (_label, summary, title) => {
    const text = composeSessionNotice(row({ summary, title }), SUMMARY_MAX_CHARS, lead);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(NOTICE_MAX_BYTES);
    expect(text.startsWith(`${lead}\n`)).toBe(true);
    expect(text).toContain(SUMMARY_DIRECTIVE);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('a pathological forty-section summary still keeps the clause, ## Goal and the bound', () => {
    const sections: string[] = [];
    for (let i = 0; i < 40; i++) {
      const heading =
        i === 0
          ? '## Goal'
          : `## Section number ${i} with an extremely long heading`.padEnd(90, 'x');
      sections.push(heading, `body ${i}`);
    }
    const text = composeSessionNotice(
      row({ summary: sections.join('\n'), title: 'a'.repeat(1000) }),
      SUMMARY_MAX_CHARS,
      lead,
    );
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(NOTICE_MAX_BYTES);
    expect(text.startsWith(`${lead}\n`)).toBe(true);
    expect(text).toMatch(/\+\d+ more/);
  });
});
