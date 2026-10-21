import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MarkdownContent } from './markdown-content';

const markdown = `# Heading

| Name | Value |
| --- | --- |
| retained | **42** |

- [x] Done
- [ ] Pending
  - Nested *detail*

3. Third
4. Fourth

~~Removed~~ [Safe](https://example.com) [Unsafe](javascript:alert%281%29)

Footnote[^note]

[^note]: Full footnote content

> Quote

\`\`\`js
const answer = 42;
\`\`\`
`;

describe('MarkdownContent', () => {
  it('owns PNG presentation through local Tailwind descendants without changing view styling', () => {
    const exported = renderToStaticMarkup(<MarkdownContent markdown={markdown} imageExport />);
    const wrapper = exported
      .match(/^<div class="([^"]+)"/)?.[1]
      ?.replaceAll('&amp;', '&')
      .replaceAll('&gt;', '>');
    for (const utility of [
      'detail-image-markdown',
      'text-[34px]',
      'leading-[53px]',
      '[&_:is(h1,h2,h3,h4,h5,h6)]:text-[38px]',
      '[&_:is(h1,h2,h3,h4,h5,h6)]:normal-case',
      '[&_:is(h1,h2,h3,h4,h5,h6)]:tracking-normal',
      '[&_:is(h1,h2,h3,h4,h5,h6)]:[font-family:var(--font-geist),sans-serif]',
      '[&_a]:no-underline',
      '[&_a:hover]:no-underline',
      '[&_a]:text-[#c6f24e]',
      '[&_strong]:font-semibold',
      '[&_strong]:text-[#fafafa]',
      '[&_pre]:text-[26px]',
      '[&_pre]:leading-[42px]',
      '[&_pre]:p-[24px]',
      '[&_pre]:whitespace-pre-wrap',
      '[&_pre]:[overflow-wrap:anywhere]',
      '[&_pre_code]:[font:inherit]',
      '[&_pre_code]:p-0',
      '[&_code]:text-[28px]',
      '[&_table]:table-fixed',
      '[&_table]:text-[28px]',
      '[&_:is(th,td)]:border-2',
      '[&_:is(th,td)]:p-[16px]',
      '[&_input[type=checkbox]]:size-[24px]',
      '[&_input[type=checkbox]:checked]:bg-[#c6f24e]',
      '[&_blockquote]:pl-[24px]',
      '[&_.sr-only]:not-sr-only',
      '[&>:first-child]:mt-0',
      '[&>:last-child]:mb-0',
    ]) {
      expect(wrapper).toContain(utility);
    }
    const view = renderToStaticMarkup(<MarkdownContent markdown={markdown} />);
    expect(view).toMatch(/^<div class="markdown-content(?:\s[^"]*)?">/);
    expect(view).toContain('uppercase');
    expect(view).toContain('hover:underline');
  });
  it('labels both task states accessibly in views and image exports without changing their text', () => {
    for (const imageExport of [false, true]) {
      const html = renderToStaticMarkup(
        <MarkdownContent
          markdown={'- [x] Keep exact whitespace\n- [ ] Keep every link'}
          imageExport={imageExport}
        />,
      );
      const inputs = html.match(/<input\b[^>]*>/g);
      expect(inputs).toHaveLength(2);
      expect(inputs?.[0]).toContain('aria-label="Completed task"');
      expect(inputs?.[0]).toContain('checked=""');
      expect(inputs?.[1]).toContain('aria-label="Incomplete task"');
      expect(inputs?.[1]).not.toContain('checked=""');
      expect(inputs?.every((input) => input.includes('disabled=""'))).toBe(true);
      expect(html).toContain('Keep exact whitespace');
      expect(html).toContain('Keep every link');
    }
  });

  it('preserves one page h1 and the existing Markdown heading remapping', () => {
    const html = renderToStaticMarkup(
      <>
        <h1>Page title</h1>
        <MarkdownContent markdown={'# Content\n\n## Source\n\n### Target'} />
      </>,
    );
    expect(html.match(/<h1\b/g) ?? []).toHaveLength(1);
    expect(html).toMatch(/<h3\b[^>]*>Content<\/h3>/);
    expect(html).toMatch(/<h3\b[^>]*>Source<\/h3>/);
    expect(html).toMatch(/<h4\b[^>]*>Target<\/h4>/);
  });

  it('removes the nested inline-code box only inside fenced code', () => {
    const html = renderToStaticMarkup(
      <MarkdownContent markdown={'`inline`\n\n```js\nconst answer = 42;\n```'} />,
    );
    expect(html).toMatch(/<code[^>]*class="[^"]*border[^>]*>inline<\/code>/);
    const pre = html
      .match(/<pre\b[^>]*>/)?.[0]
      .replaceAll('&amp;', '&')
      .replaceAll('&gt;', '>');
    expect(pre).toContain('[&>code]:border-0');
    expect(pre).toContain('[&>code]:p-0');
    expect(pre).toContain('[&>code]:bg-transparent');
    expect(pre).toContain('[&>code]:rounded-none');
  });

  it('keeps repeated footnotes unique and linked across multiple renderers', () => {
    const source = 'Footnote[^same]\n\n[^same]: Retained note';
    const html = renderToStaticMarkup(
      <>
        <MarkdownContent markdown={source} />
        <MarkdownContent markdown={source} />
      </>,
    );
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(ids.length);
    for (const match of html.matchAll(/(?:href="#|aria-describedby=")([^"]+)"/g)) {
      expect(ids).toContain(match[1]);
    }
  });

  it('styles tables and preserves explicit cell alignment', () => {
    const html = renderToStaticMarkup(
      <MarkdownContent markdown={'| Left | Right |\n| :--- | ---: |\n| first | second |'} />,
    );
    expect(html).toMatch(/<table[^>]*class="[^"]*border-collapse/);
    expect(html).toMatch(/<th[^>]*class="[^"]*border-border[^"]*text-right/);
    expect(html).toMatch(/<td[^>]*class="[^"]*border-border[^"]*text-right/);
    expect(html).toContain('first');
    expect(html).toContain('second');
  });
  it('shares semantic markup between view and image export, with separate wrappers', () => {
    const view = renderToStaticMarkup(<MarkdownContent markdown={markdown} />);
    const exported = renderToStaticMarkup(<MarkdownContent markdown={markdown} imageExport />);
    expect(exported).toContain('class="detail-image-markdown');
    expect(view).toMatch(/class="markdown-content(?:\s[^"]*)?"/);
    expect(exported.slice(exported.indexOf('>') + 1)).toBe(view.slice(view.indexOf('>') + 1));
    for (const html of [view, exported]) {
      expect(html).toMatch(/<table\b/);
      expect(html).toMatch(/tabindex="0"[^>]*aria-label="Markdown table"/);
      expect(html).toContain('<strong');
      expect(html).toContain('<em');
      expect(html).toContain('<del>Removed</del>');
      expect(html.match(/type="checkbox"/g) ?? []).toHaveLength(2);
      expect(html).toMatch(/class="[^"]*\btask-list-item\b/);
      expect(html).toContain('<ol start="3"');
      expect(html).toContain('Nested');
      expect(html).toContain('Full footnote content');
      expect(html).toContain('data-footnotes');
      expect(html).toMatch(/id="[^"]+-footnote-label"/);
      expect(html).toMatch(/href="#[^"]+-user-content-fn-note"/);
      expect(html).toMatch(/id="[^"]+-user-content-fn-note"/);
      expect(html).toMatch(/id="[^"]+-user-content-fnref-note"/);
      expect(html).toContain('<h3');
      expect(html).toContain('href="https://example.com"');
      expect(html).not.toContain('href="javascript:');
      expect(html).toContain('>Unsafe</a>');
      expect(html).toContain('<blockquote');
      expect(html).toContain('const answer = 42;');
    }
  });

  it.each([
    '![Remote](https://example.com/image.png)',
    '![Reference][image]\n\n[image]: https://example.com/image.png',
    '<img src="https://example.com/image.png">',
    'Before <b>HTML</b> after',
  ])('explicitly rejects unsupported image/HTML export: %s', (source) => {
    expect(() => renderToStaticMarkup(<MarkdownContent markdown={source} imageExport />)).toThrow(
      /Unsupported (image|HTML) in image export/,
    );
  });

  it('keeps raw HTML literal in views, and code containing HTML exportable', () => {
    const view = renderToStaticMarkup(<MarkdownContent markdown={'Before <b>HTML</b> after'} />);
    expect(view).toContain('&lt;b&gt;HTML&lt;/b&gt;');
    expect(view).not.toContain('<b>');
    const exported = renderToStaticMarkup(
      <MarkdownContent markdown={'`<img src="remote">`'} imageExport />,
    );
    expect(exported).toContain('&lt;img');
  });
});
