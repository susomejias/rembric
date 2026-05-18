import { describe, expect, it } from 'vitest';

import { SessionRouter } from './session-router.js';

describe('SessionRouter', () => {
  it('isolates entries per (tokenId, mcpSessionId) pair', () => {
    const r = new SessionRouter();
    r.setActiveSession('tok-1', 'mcp-A', 'session-A');
    r.setActiveSession('tok-1', 'mcp-B', 'session-B');
    expect(r.get('tok-1', 'mcp-A')?.rembricSessionId).toBe('session-A');
    expect(r.get('tok-1', 'mcp-B')?.rembricSessionId).toBe('session-B');
  });

  it('does not bleed across tokens', () => {
    const r = new SessionRouter();
    r.setActiveSession('tok-1', 'mcp-A', 'session-A');
    expect(r.get('tok-2', 'mcp-A')).toBeUndefined();
  });

  it('returns a defensive copy of suggestedSlugs', () => {
    const r = new SessionRouter();
    r.setSuggestedSlugs('tok-1', 'mcp-A', ['foo', 'bar']);
    const got = r.get('tok-1', 'mcp-A');
    got!.pendingSuggestedSlugs.push('mutated-externally');
    expect(r.get('tok-1', 'mcp-A')?.pendingSuggestedSlugs).toEqual(['foo', 'bar']);
  });

  it('clearSession nulls the rembricSessionId but keeps the entry', () => {
    const r = new SessionRouter();
    r.setActiveSession('t', 'm', 'S1');
    r.setActiveProject('t', 'm', 'P1', 'tool-explicit');
    r.clearSession('t', 'm');
    const entry = r.get('t', 'm');
    expect(entry?.rembricSessionId).toBeNull();
    expect(entry?.projectId).toBe('P1');
  });

  it('setActiveProject records the resolution source', () => {
    const r = new SessionRouter();
    r.setActiveProject('t', 'm', 'P1', 'roots');
    expect(r.get('t', 'm')?.projectResolutionSource).toBe('roots');
    r.setActiveProject('t', 'm', 'P2', 'tool-explicit');
    expect(r.get('t', 'm')?.projectResolutionSource).toBe('tool-explicit');
  });

  it('size reports the number of live entries', () => {
    const r = new SessionRouter();
    expect(r.size()).toBe(0);
    r.setActiveSession('t', 'a', 'S1');
    r.setActiveSession('t', 'b', 'S2');
    expect(r.size()).toBe(2);
    r.resetAll();
    expect(r.size()).toBe(0);
  });
});
