import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MarkdownPanel } from './markdown-panel';

describe('MarkdownPanel presentation', () => {
  it('renders GFM tables, checklists, strikethrough and safe links through the panel', () => {
    const html = renderToStaticMarkup(
      <MarkdownPanel
        title="Content"
        markdown={
          '| Name | Value |\n| --- | --- |\n| retained | 42 |\n\n- [x] Done\n- [ ] Pending\n\n~~Removed~~ [Safe](https://example.com) [Unsafe](javascript:alert%281%29)'
        }
      />,
    );
    expect(html.match(/<table\b/g) ?? []).toHaveLength(1);
    expect(html).toMatch(/<th\b[^>]*>Name<\/th>/);
    expect(html).toMatch(/<td\b[^>]*>retained<\/td>/);
    expect(html.match(/type="checkbox"/g) ?? []).toHaveLength(2);
    expect(html).toContain('checked=""');
    expect(html).toContain('<del>Removed</del>');
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('>Unsafe</a>');
  });
  it('omits only the toolbar when requested, preserving content headings and markdown', () => {
    const html = renderToStaticMarkup(
      <MarkdownPanel
        presentation="reading"
        hideToolbar
        title="Context"
        markdown={'## Source\n\nSource snapshot\n\n## Target\n\nTarget snapshot'}
      />,
    );
    expect(html).not.toContain('<button');
    expect(html).toContain('<h2 class="sr-only">Context</h2>');
    expect(html).not.toContain('border-b');
    expect(html).toContain('>Source</h3>');
    expect(html).toContain('>Target</h3>');
    expect(html).toContain('Source snapshot');
    expect(html).toContain('Target snapshot');
  });
  it('keeps overflowing code keyboard-scrollable', () => {
    const html = renderToStaticMarkup(
      <MarkdownPanel title="Code" markdown={'```\nlong-token\n```'} />,
    );
    expect(html).toMatch(/<pre[^>]*tabindex="0"/);
  });
  it('keeps the default toolbar and source/target headings for existing consumers', () => {
    const html = renderToStaticMarkup(
      <MarkdownPanel title="Source" markdown={'## Target\n\nSnapshot'} />,
    );
    expect(html).toContain('>Source</h2>');
    expect(html).toContain('>Target</h3>');
    expect(html).toContain('aria-label="Copy markdown"');
  });
});
