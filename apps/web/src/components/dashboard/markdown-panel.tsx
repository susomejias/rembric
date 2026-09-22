'use client';

import { Check, Copy } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';

import { LABEL } from './ui';

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
    <section className="mb-5 border border-primary/40 bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 md:px-6">
        <div>
          <p className={`flex items-center gap-2 text-primary ${LABEL}`}>
            <span aria-hidden="true" className="inline-block size-[0.55em] shrink-0 bg-primary" />
            {eyebrow}
          </p>
          <h2 className="mt-1 text-base font-medium">{title}</h2>
        </div>
        <div className="flex items-center gap-2">
          {action}
          <button
            type="button"
            onClick={copy}
            aria-label={copyLabel}
            className={`flex items-center gap-2 border border-border px-3 py-1.5 text-muted-foreground transition-colors hover:border-primary hover:text-primary ${LABEL}`}
          >
            {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
            {copied ? 'Copied' : copyLabel}
          </button>
        </div>
      </div>
      <div className="px-5 py-5 text-sm leading-7 text-muted-foreground md:px-6">
        <ReactMarkdown components={MARKDOWN_COMPONENTS}>{markdown}</ReactMarkdown>
      </div>
    </section>
  );
}

const MARKDOWN_COMPONENTS = {
  h1: ({ children }: { children?: ReactNode }) => (
    <h3 className="mb-3 text-lg font-medium tracking-[-.03em] text-foreground">{children}</h3>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <h3 className={`mt-5 mb-3 text-primary ${LABEL}`}>{children}</h3>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <h4 className="mt-4 mb-2 text-sm font-medium text-foreground">{children}</h4>
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
    <strong className="font-medium text-primary">{children}</strong>
  ),
  em: ({ children }: { children?: ReactNode }) => <em className="italic">{children}</em>,
  a: ({ children, href }: { children?: ReactNode; href?: string }) => (
    <a
      href={href}
      className="text-primary underline-offset-4 hover:underline"
      rel="noreferrer noopener"
    >
      {children}
    </a>
  ),
  code: ({ children }: { children?: ReactNode }) => (
    <code className="border border-border bg-muted px-1.5 py-0.5 font-mono text-[.8em] text-foreground">
      {children}
    </code>
  ),
  pre: ({ children }: { children?: ReactNode }) => (
    <pre className="mb-3 overflow-x-auto border border-border bg-muted p-3 font-mono text-xs leading-5">
      {children}
    </pre>
  ),
  hr: () => <hr className="my-4 border-border" />,
  blockquote: ({ children }: { children?: ReactNode }) => (
    <blockquote className="mb-3 border-l-2 border-primary/30 pl-4 text-muted-foreground">
      {children}
    </blockquote>
  ),
};
