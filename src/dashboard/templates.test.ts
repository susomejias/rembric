import { describe, expect, it } from 'vitest';

import { escape, formatTs, html, isSafeHtml, minifyHtml, raw, shell } from './templates.js';

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

  it('emits no <style> block in the body — CSS comes from <link> tags', () => {
    const body = html`<p>hi</p>`;
    const out = shell(body, { title: 't' });
    expect(out.includes('<style>')).toBe(false);
    expect(out.includes('<style ')).toBe(false);
  });

  it('injects favicon links in <head>', () => {
    const out = shell(html`<p>hi</p>`, { title: 't' });
    const head = out.slice(out.indexOf('<head>'), out.indexOf('</head>'));
    expect(head).toContain('rel="icon"');
    expect(head).toContain('favicon-32.png');
    expect(head).toContain('favicon-16.png');
  });

  it('renders the global confirmation <dialog> at the bottom of <body>', () => {
    const out = shell(html`<p>hi</p>`, { title: 't' });
    expect(out).toContain('id="rbr-confirm"');
    expect(out).toContain('class="modal"');
    expect(out).toContain('data-tone="danger"');
  });
});

describe('minifyHtml', () => {
  it('collapses runs of whitespace between tags', () => {
    const input = '<div>\n  <p>hi</p>\n  <p>bye</p>\n</div>';
    expect(minifyHtml(input)).toBe('<div><p>hi</p><p>bye</p></div>');
  });

  it('preserves whitespace inside <pre>, <textarea>, and <script>', () => {
    const input =
      '<div>\n  <pre>\n line 1\n line 2\n</pre>\n  <script>\n  var x;\n  </script>\n</div>';
    const out = minifyHtml(input);
    expect(out).toContain('<pre>\n line 1\n line 2\n</pre>');
    expect(out).toContain('<script>\n  var x;\n  </script>');
  });

  it('strips HTML comments', () => {
    const input = '<div><!-- a comment -->hi</div>';
    expect(minifyHtml(input)).toBe('<div>hi</div>');
  });
});

describe('escape', () => {
  it('escapes the five HTML metacharacters', () => {
    expect(escape('<a href="x">y & z</a>')).toBe('&lt;a href=&quot;x&quot;&gt;y &amp; z&lt;/a&gt;');
    expect(escape("it's")).toBe('it&#39;s');
  });
});

describe('html`` + raw', () => {
  it('html`` escapes interpolated strings; raw() passes through', () => {
    const dangerous = '<script>alert(1)</script>';
    expect(html`${dangerous}`.__html).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html`${raw(dangerous)}`.__html).toBe(dangerous);
  });
});
