import { describe, expect, it } from 'vitest';

import {
  composeSessionNotice,
  evaluateSessionNudge,
  NOTICE_MAX_BYTES,
  NOTICE_SUMMARY_MAX_CHARS,
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
    expect(evaluateSessionNudge(r, minutesAfter(STARTED, 60), FLOOR_MS)).toBeNull();
  });

  it('fires when work followed a null summary, past the floor', () => {
    const r = row({ lastWorkAt: minutesAfter(STARTED, 30) });
    expect(evaluateSessionNudge(r, minutesAfter(STARTED, 40), FLOOR_MS)).not.toBeNull();
  });

  it('does not fire when the summary was written after the work', () => {
    const r = row({
      lastWorkAt: minutesAfter(STARTED, 30),
      lastSummaryAt: minutesAfter(STARTED, 35),
    });
    expect(evaluateSessionNudge(r, minutesAfter(STARTED, 60), FLOOR_MS)).toBeNull();
  });

  it('fires again once further work follows the summary write', () => {
    const r = row({
      lastWorkAt: minutesAfter(STARTED, 60),
      lastSummaryAt: minutesAfter(STARTED, 35),
    });
    expect(evaluateSessionNudge(r, minutesAfter(STARTED, 90), FLOOR_MS)).not.toBeNull();
  });

  it('does not fire before one floor has elapsed since started_at, with lastNudgeAt null', () => {
    const r = row({ lastWorkAt: minutesAfter(STARTED, 1) });
    const almostFloor = minutesAfter(STARTED, 24);
    expect(evaluateSessionNudge(r, almostFloor, FLOOR_MS)).toBeNull();
    const pastFloor = minutesAfter(STARTED, 26);
    expect(evaluateSessionNudge(r, pastFloor, FLOOR_MS)).not.toBeNull();
  });

  it('is not repeated inside the floor after a notice was emitted', () => {
    const nudgedAt = minutesAfter(STARTED, 30);
    const r = row({ lastWorkAt: nudgedAt, lastNudgeAt: nudgedAt });
    expect(evaluateSessionNudge(r, minutesAfter(nudgedAt, 10), FLOOR_MS)).toBeNull();
    expect(evaluateSessionNudge(r, minutesAfter(nudgedAt, 26), FLOOR_MS)).not.toBeNull();
  });
});

describe('composeSessionNotice', () => {
  it('states the merge rule without re-deriving it, and licenses not calling', () => {
    const text = composeSessionNotice(row({ summary: '## Goal\nship it', title: 'demo' }));
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
    const text = composeSessionNotice(row({ summary, title: 'my session' }));
    expect(text).toContain('my session');
    expect(text).toContain('## Goal');
    expect(text).toContain('## Files');
    expect(text).toMatch(/current sizes, not targets/);
    expect(text).toMatch(
      new RegExp(`${summary.length} used of ${NOTICE_SUMMARY_MAX_CHARS} available\\.`),
    );
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(NOTICE_MAX_BYTES);
  });

  it('replaces the inventory with the canonical section list when nothing is stored', () => {
    const text = composeSessionNotice(row({ summary: null, title: 'fresh' }));
    expect(text).toContain('## Goal');
    expect(text).toContain('## Accomplished');
    expect(text).toContain('## Decisions+why');
    expect(text).toContain('## Verified+how');
    expect(text).toContain('## Unfinished+why');
    expect(text).toContain('## Files');
    expect(text).toContain('0 used of');
  });

  it('a summary with no ## heading is treated as nothing stored', () => {
    const text = composeSessionNotice(row({ summary: 'just some prose, no headings', title: 't' }));
    expect(text).toContain('## Goal');
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
    const text = composeSessionNotice(row({ summary, title: 'pathological' }));
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(NOTICE_MAX_BYTES);
    expect(text).toContain('## Goal');
    expect(text).toMatch(/\+\d+ more/);
  });
});
