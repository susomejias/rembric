import { describe, expect, it } from 'vitest';

import { SUMMARY_MAX_CHARS } from './agent-sessions.js';
import {
  composeSessionNotice,
  evaluateSessionNudge,
  NOTICE_MAX_BYTES,
  type SessionNudgeRow,
} from './session-nudge.js';

const FLOOR_MS = 25 * 60_000;
const STARTED = new Date('2026-01-01T00:00:00.000Z');

function row(overrides: Partial<SessionNudgeRow> = {}): SessionNudgeRow {
  return {
    startedAt: STARTED,
    lastWorkAt: null,
    lastSummaryAt: null,
    lastNudgeAt: null,
    summary: null,
    title: 'a session',
    ...overrides,
  };
}

function minutesAfter(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

describe('evaluateSessionNudge — the gate', () => {
  it('never fires with no work reported', () => {
    const r = row({ lastWorkAt: null });
    expect(
      evaluateSessionNudge(r, minutesAfter(STARTED, 60), FLOOR_MS, SUMMARY_MAX_CHARS),
    ).toBeNull();
  });

  it('fires when work followed a null summary, past the floor', () => {
    const r = row({ lastWorkAt: minutesAfter(STARTED, 30) });
    expect(
      evaluateSessionNudge(r, minutesAfter(STARTED, 40), FLOOR_MS, SUMMARY_MAX_CHARS),
    ).not.toBeNull();
  });

  it('does not fire when the summary is no older than the work', () => {
    // `last_work_at` is the reported turn's START, and the summary write is
    // normally that turn's LAST activity, so EQUALITY is the state a
    // summary-writing turn actually produces — `work < summary` only shows
    // up when a later turn wrote one without reporting a tool.
    const writtenAt = minutesAfter(STARTED, 30);
    expect(
      evaluateSessionNudge(
        row({ lastWorkAt: writtenAt, lastSummaryAt: writtenAt }),
        minutesAfter(STARTED, 60),
        FLOOR_MS,
        SUMMARY_MAX_CHARS,
      ),
    ).toBeNull();
    expect(
      evaluateSessionNudge(
        row({ lastWorkAt: writtenAt, lastSummaryAt: minutesAfter(STARTED, 35) }),
        minutesAfter(STARTED, 60),
        FLOOR_MS,
        SUMMARY_MAX_CHARS,
      ),
    ).toBeNull();
  });

  it('fires again once further work follows the summary write', () => {
    const r = row({
      lastWorkAt: minutesAfter(STARTED, 60),
      lastSummaryAt: minutesAfter(STARTED, 35),
    });
    expect(
      evaluateSessionNudge(r, minutesAfter(STARTED, 90), FLOOR_MS, SUMMARY_MAX_CHARS),
    ).not.toBeNull();
  });

  it('does not fire before one floor has elapsed since started_at, with lastNudgeAt null', () => {
    const r = row({ lastWorkAt: minutesAfter(STARTED, 1) });
    const almostFloor = minutesAfter(STARTED, 24);
    expect(evaluateSessionNudge(r, almostFloor, FLOOR_MS, SUMMARY_MAX_CHARS)).toBeNull();
    const pastFloor = minutesAfter(STARTED, 26);
    expect(evaluateSessionNudge(r, pastFloor, FLOOR_MS, SUMMARY_MAX_CHARS)).not.toBeNull();
  });

  it('is not repeated inside the floor after a notice was emitted', () => {
    const nudgedAt = minutesAfter(STARTED, 30);
    const r = row({ lastWorkAt: nudgedAt, lastNudgeAt: nudgedAt });
    expect(
      evaluateSessionNudge(r, minutesAfter(nudgedAt, 10), FLOOR_MS, SUMMARY_MAX_CHARS),
    ).toBeNull();
    expect(
      evaluateSessionNudge(r, minutesAfter(nudgedAt, 26), FLOOR_MS, SUMMARY_MAX_CHARS),
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
    // The leading ASCII char is what makes this discriminating: it shifts the
    // cut onto an odd code-unit boundary, so a naive `slice` stops exactly
    // between the two units of an emoji.
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
    // The 32-code-unit display cut falls exactly between the two code units
    // of the emoji; a naked slice keeps the high surrogate, which decodes to
    // U+FFFD wherever the notice is read back.
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
    // The shape `computePlaceholderTitle` produces from a deep cwd: the title
    // is the variable-length input of BOTH branches, not only the
    // nothing-stored one.
    const title = `${'deep-directory-name'.repeat(21)} · 09:41 UTC`;
    const text = composeSessionNotice(
      row({ summary: '## Goal\nship it', title }),
      SUMMARY_MAX_CHARS,
    );
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(NOTICE_MAX_BYTES);
  });

  it('stays within the byte bound when a long title forces the every-section-elided return', () => {
    // Forty sections plus a title that leaves no room for even one entry, so
    // the builder takes its `+N more`-only path — the one return that never
    // re-checked the bound. The title is ASCII and longer than any budget, so
    // it is cut to fill the budget EXACTLY and the composed notice lands on
    // 640 on the nose: reserving one byte too few (a `+N more` label costed
    // at fewer digits than 40 needs) shows up here as 641.
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
      // Every heading after the first is unrelated padding text — NOT a
      // "Goal"-prefixed variant — so `## Goal` surviving is discriminating:
      // it can only appear in the composed text if section 0 (stored FIRST,
      // in stored order) was kept rather than elided.
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
