import type { ReactNode } from 'react';

/**
 * The dashboard's Markdown body, rendering to React elements instead of an HTML
 * string.
 *
 * The retired renderer was markdown-it with `html: false` inside a
 * `dangerouslySetInnerHTML` boundary (`apps/server/src/dashboard/components.ts`).
 * `markdown-it` is not a dependency of this workspace and a manifest edit is out
 * of scope for this slice, so the subset below is parsed here — and it is the
 * stricter boundary: raw HTML in a memory's content can only ever appear as
 * text, because React escapes every text node and the parser never emits HTML.
 *
 * Supported: fenced code blocks, ATX headings, unordered/ordered lists,
 * horizontal rules, paragraphs, and inline code / bold / emphasis / links
 * (only `http(s)`, `mailto:` and root-relative targets become anchors; anything
 * else renders as text).
 */

type Block =
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'hr' }
  | { kind: 'paragraph'; text: string };

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^```\s*(\S*)\s*$/;
const BULLET = /^[-*+]\s+(.*)$/;
const NUMBERED = /^\d+[.)]\s+(.*)$/;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/;

export function parseMarkdownBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && FENCE.exec(lines[i] ?? '') === null) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      blocks.push({ kind: 'code', lang: fence[1] ?? '', text: body.join('\n') });
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      continue;
    }

    if (RULE.test(line.trim())) {
      flushParagraph();
      blocks.push({ kind: 'hr' });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length, text: heading[2] ?? '' });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = numbered !== null;
      const items: string[] = [(bullet ?? numbered)?.[1] ?? ''];
      while (i + 1 < lines.length) {
        const next = lines[i + 1] ?? '';
        const nextItem = ordered ? NUMBERED.exec(next) : BULLET.exec(next);
        if (nextItem === null) break;
        items.push(nextItem[1] ?? '');
        i += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  return blocks;
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;

/** Only a target that cannot carry a script scheme becomes a link. */
function safeHref(url: string): string | null {
  return /^(?:https?:\/\/|mailto:|\/)/i.test(url) ? url : null;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let index = 0;
  INLINE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${index}`;
    index += 1;

    if (token.startsWith('`')) {
      out.push(
        <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**')) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('*')) {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const label = token.slice(1, token.indexOf(']'));
      const href = safeHref(token.slice(token.indexOf('(') + 1, -1));
      out.push(
        href === null ? (
          label
        ) : (
          <a key={key} href={href} className="underline underline-offset-2">
            {label}
          </a>
        ),
      );
    }

    last = match.index + token.length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

const HEADING_CLASS: Record<number, string> = {
  1: 'font-display text-xl font-semibold',
  2: 'font-display text-lg font-semibold',
  3: 'font-display text-base font-semibold',
  4: 'font-display text-sm font-semibold',
  5: 'font-display text-sm font-semibold',
  6: 'font-display text-sm font-semibold',
};

export function Markdown({ content, className }: { content: string; className?: string }) {
  const blocks = parseMarkdownBlocks(content);
  return (
    <div className={className}>
      {blocks.map((block, i) => {
        const key = `b${i}`;
        switch (block.kind) {
          case 'code':
            return (
              <pre
                key={key}
                className="my-3 overflow-x-auto rounded-xl border bg-muted p-3 font-mono text-xs"
              >
                <code data-lang={block.lang}>{block.text}</code>
              </pre>
            );
          case 'heading':
            return (
              <p key={key} className={`mt-4 mb-1 first:mt-0 ${HEADING_CLASS[block.level] ?? ''}`}>
                {renderInline(block.text, key)}
              </p>
            );
          case 'list':
            return block.ordered ? (
              <ol key={key} className="my-2 list-decimal space-y-1 pl-5">
                {block.items.map((item, j) => (
                  <li key={`${key}-${j}`}>{renderInline(item, `${key}-${j}`)}</li>
                ))}
              </ol>
            ) : (
              <ul key={key} className="my-2 list-disc space-y-1 pl-5">
                {block.items.map((item, j) => (
                  <li key={`${key}-${j}`}>{renderInline(item, `${key}-${j}`)}</li>
                ))}
              </ul>
            );
          case 'hr':
            return <hr key={key} className="my-4 border-border" />;
          default:
            return (
              <p key={key} className="mt-2 mb-2 text-sm leading-relaxed first:mt-0">
                {renderInline(block.text, key)}
              </p>
            );
        }
      })}
    </div>
  );
}
