import { describe, expect, it } from 'vitest';

import { parseSessionLearnings } from './validation';

describe('parseSessionLearnings', () => {
  it('accepts a report with an optional agentType and ignores unknown properties', () => {
    expect(parseSessionLearnings({ report: 'r' })).toEqual({
      ok: true,
      data: { report: 'r', agentType: undefined },
    });
    expect(
      parseSessionLearnings({ report: 'r', agentType: 'a'.repeat(120), transcript: 'x' }),
    ).toEqual({ ok: true, data: { report: 'r', agentType: 'a'.repeat(120) } });
  });

  it.each([
    ['missing', {}],
    ['empty', { report: '' }],
    ['non-string', { report: 42 }],
  ])('refuses a %s report, naming report', (_label, body) => {
    const out = parseSessionLearnings(body);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toMatch(/^report: /);
  });

  it.each([
    ['empty', ''],
    ['over 120 characters', 'a'.repeat(121)],
    ['non-string', 7],
  ])('refuses an agentType that is %s, naming agentType', (_label, agentType) => {
    const out = parseSessionLearnings({ report: 'r', agentType });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toMatch(/^agentType: /);
  });

  it('refuses a body that is not an object', () => {
    expect(parseSessionLearnings('report').ok).toBe(false);
    expect(parseSessionLearnings(null).ok).toBe(false);
  });
});
