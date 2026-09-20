'use client';

import { Check, Copy } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';

import { EYEBROW } from './ui';

/**
 * A markdown body inside the v0 panel frame, with the mockup's copy control.
 *
 * `react-markdown` is safe by construction for this boundary — raw HTML in a
 * memory's content is never rendered as markup, every text node is escaped, and
 * no `rehype-raw` is installed — which is the same guarantee the retired
 * `markdown-it`-with-`html:false` renderer gave.
 *
 * The element mapping is explicit rather than the mockup's `prose prose-invert`
 * classes: `prose` comes from `@tailwindcss/typography`, which this workspace
 * does not depend on, so those classes generate no CSS at all and the markdown
 * would render at the browser's defaults. Each element therefore names its own
 * ink role here.
 */
export function MarkdownPanel({
  eyebrow,
  title,
  markdown,
  copyLabel = 'Copy markdown',
  action,
}: {
  eyebrow: string;
  title: string;
  markdown: string;
  copyLabel?: string;
  action?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);

  const copy = (): void => {
    void navigator.clipboard.writeText(markdown).then(() => {
      setCopied(true);
      window.setTimeout(() => {
        setCopied(false);
      }, 1600);
    });
  };

  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-(--accent-ink)/15 bg-(--surface-panel)">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-(--ink)/[7%] px-5 py-4 md:px-6">
        <div>
          <p className={`text-(--accent-ink)/60 ${EYEBROW}`}>{eyebrow}</p>
          <h2 className="mt-1 text-base font-medium">{title}</h2>
        </div>
        <div className="flex items-center gap-2">
          {action}
          <button
            type="button"
            onClick={copy}
            aria-label={copyLabel}
            className="flex items-center gap-2 rounded-lg border border-(--ink)/[7.5%] bg-(--ink)/[3%] px-3 py-2 text-[11px] text-(--ink)/55 transition-colors hover:bg-(--ink)/[7%] hover:text-(--ink)/85"
          >
            {copied ? (
              <Check className="size-3.5 text-(--accent-ink-strong)" />
            ) : (
              <Copy className="size-3.5" />
            )}
            {copied ? 'Copied' : copyLabel}
          </button>
        </div>
      </div>
      <div className="px-5 py-5 text-sm leading-7 text-(--ink)/60 md:px-6">
        <ReactMarkdown components={MARKDOWN_COMPONENTS}>{markdown}</ReactMarkdown>
      </div>
    </section>
  );
}

const MARKDOWN_COMPONENTS = {
  h1: ({ children }: { children?: ReactNode }) => (
    <h3 className="mb-3 text-lg font-medium tracking-[-.03em] text-(--ink)/90">{children}</h3>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <h3 className={`mt-5 mb-3 text-(--accent-ink)/70 ${EYEBROW}`}>{children}</h3>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <h4 className="mt-4 mb-2 text-sm font-medium text-(--ink)/85">{children}</h4>
  ),
  p: ({ children }: { children?: ReactNode }) => (
    <p className="mb-3 leading-7 last:mb-0">{children}</p>
  ),
  ul: ({ children }: { children?: ReactNode }) => (
    <ul className="mb-3 ml-5 list-disc space-y-1">{children}</ul>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol className="mb-3 ml-5 list-decimal space-y-1">{children}</ol>
  ),
  li: ({ children }: { children?: ReactNode }) => <li className="leading-6">{children}</li>,
  strong: ({ children }: { children?: ReactNode }) => (
    <strong className="font-medium text-(--accent-ink)">{children}</strong>
  ),
  em: ({ children }: { children?: ReactNode }) => <em className="italic">{children}</em>,
  a: ({ children, href }: { children?: ReactNode; href?: string }) => (
    <a
      href={href}
      className="text-(--accent-ink) underline-offset-4 hover:underline"
      rel="noreferrer noopener"
    >
      {children}
    </a>
  ),
  code: ({ children }: { children?: ReactNode }) => (
    <code className="rounded border border-(--ink)/[10%] bg-(--ink)/[4%] px-1.5 py-0.5 font-mono text-[.8em] text-(--ink)/85">
      {children}
    </code>
  ),
  pre: ({ children }: { children?: ReactNode }) => (
    <pre className="mb-3 overflow-x-auto rounded-lg border border-(--ink)/[7.5%] bg-(--surface-tile) p-3 font-mono text-xs leading-5">
      {children}
    </pre>
  ),
  hr: () => <hr className="my-4 border-(--ink)/[7%]" />,
  blockquote: ({ children }: { children?: ReactNode }) => (
    <blockquote className="mb-3 border-l-2 border-(--accent-ink)/40 pl-4 text-(--ink)/55">
      {children}
    </blockquote>
  ),
};
