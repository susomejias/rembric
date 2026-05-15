import { describe, expect, it } from 'vitest';

import { formatTs, html, isSafeHtml, shell } from './templates.js';

describe('formatTs', () => {
  it('emits a <time> element with datetime, data-rembric-ts marker, and UTC fallback for a valid Date', () => {
    const d = new Date('2026-05-15T16:35:12.975Z');
    const out = formatTs(d);
    expect(isSafeHtml(out)).toBe(true);
    expect(out.__html).toBe(
      '<time datetime="2026-05-15T16:35:12.975Z" data-rembric-ts>2026-05-15 16:35:12 UTC</time>',
    );
  });

  it('accepts ISO strings and numeric epoch milliseconds', () => {
    const iso = formatTs('2026-05-15T16:35:12.975Z');
    const ms = formatTs(new Date('2026-05-15T16:35:12.975Z').getTime());
    expect(iso.__html).toContain('datetime="2026-05-15T16:35:12.975Z"');
    expect(iso.__html).toContain('2026-05-15 16:35:12 UTC');
    expect(ms.__html).toContain('2026-05-15 16:35:12 UTC');
  });

  it('returns a bare em-dash (no <time> element) for null, undefined, or invalid input', () => {
    expect(formatTs(null).__html).toBe('—');
    expect(formatTs(undefined).__html).toBe('—');
    expect(formatTs('not a date').__html).toBe('—');
    expect(formatTs(new Date('not a date')).__html).toBe('—');
  });

  it('renders unescaped when interpolated through html`` tagged template', () => {
    const out = html`<td>${formatTs(new Date('2026-05-15T16:35:12.000Z'))}</td>`;
    expect(out.__html).toBe(
      '<td><time datetime="2026-05-15T16:35:12.000Z" data-rembric-ts>2026-05-15 16:35:12 UTC</time></td>',
    );
  });
});

describe('shell()', () => {
  it('injects the timestamp upgrader script exactly once into <head>', () => {
    const body = html`<p>hi</p>`;
    const out = shell(body, { title: 't' });
    const headStart = out.indexOf('<head>');
    const headEnd = out.indexOf('</head>');
    expect(headStart).toBeGreaterThan(-1);
    expect(headEnd).toBeGreaterThan(headStart);
    const head = out.slice(headStart, headEnd);
    expect(head).toContain('data-rembric-ts');
    expect(head).toContain('Intl.DateTimeFormat');
    expect(head).toContain('htmx:afterSwap');
    const scriptMatches = out.match(/<script>[\s\S]*?<\/script>/g) ?? [];
    const upgraderScripts = scriptMatches.filter((s) => s.includes('data-rembric-ts'));
    expect(upgraderScripts).toHaveLength(1);
  });
});
