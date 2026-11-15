import { describe, expect, it } from 'vitest';

import { UsageCounters } from '@rembric/core';

describe('UsageCounters', () => {
  it('increments one cell per record, and reads back through snapshot', () => {
    const counters = new UsageCounters();
    counters.record('t1', 'memory.search');
    counters.record('t1', 'memory.search');
    counters.record('t1', 'memory.save');

    expect(counters.get('t1', 'memory.search')).toBe(2);
    expect(counters.get('t1', 'memory.save')).toBe(1);
    expect(counters.snapshot()).toEqual({
      t1: { 'memory.search': 2, 'memory.save': 1 },
    });
  });

  it('keeps tokens apart', () => {
    const counters = new UsageCounters();
    counters.record('t1', 'memory.search');
    counters.record('t2', 'memory.search');
    counters.record('t2', 'memory.context');

    expect(counters.snapshot()).toEqual({
      t1: { 'memory.search': 1 },
      t2: { 'memory.search': 1, 'memory.context': 1 },
    });
  });

  it('a NEW instance (the restart equivalent) starts at zero', () => {
    const before = new UsageCounters();
    before.record('t1', 'memory.search');
    expect(before.get('t1', 'memory.search')).toBe(1);

    const after = new UsageCounters();
    expect(after.get('t1', 'memory.search')).toBe(0);
    expect(after.snapshot()).toEqual({});
  });

  it('snapshot is a copy — mutating it cannot corrupt the counters', () => {
    const counters = new UsageCounters();
    counters.record('t1', 'memory.search');
    const snap = counters.snapshot();
    snap.t1!['memory.search'] = 9999;
    delete snap.t2;

    expect(counters.get('t1', 'memory.search')).toBe(1);
  });

  it('counts file-recall firings and lines apart from prompt recall', () => {
    const counters = new UsageCounters();
    counters.recordFileRecall('t1', 2);
    counters.recordFileRecall('t1', 0);
    counters.recordFileRecall('t1', 1);
    counters.recordRecall('t1', 5);

    expect(counters.fileRecallSnapshot()).toEqual({
      t1: { requests: 3, nonEmpty: 2, linesServed: 3 },
    });
    expect(counters.recallSnapshot()).toEqual({
      t1: { requests: 1, nonEmpty: 1, linesServed: 5 },
    });
  });
});
