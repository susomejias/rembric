'use client';

import type { ReactNode } from 'react';

import { DetailCopy } from './detail-copy';
import { MarkdownContent } from './markdown-content';
import { LABEL } from './ui';

export function MarkdownPanel({
  eyebrow,
  title,
  markdown,
  copyMarkdown = markdown,
  copyLabel = 'Copy markdown',
  action,
  presentation = 'panel',
  hideTitle = false,
  hideToolbar = false,
}: {
  eyebrow?: string;
  title: string;
  markdown: string;
  copyMarkdown?: string;
  copyLabel?: string;
  action?: ReactNode;
  presentation?: 'panel' | 'reading';
  hideTitle?: boolean;
  hideToolbar?: boolean;
}) {
  return (
    <section
      className={
        presentation === 'reading'
          ? 'detail-markdown'
          : 'mb-5 rounded-2xl border border-border bg-card'
      }
    >
      {!hideToolbar ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-4 md:px-6">
          <div>
            {eyebrow ? (
              <p
                className={`flex items-center gap-2 text-primary ${LABEL} in-[.detail-ficha]:font-sans in-[.detail-ficha]:text-sm in-[.detail-ficha]:normal-case in-[.detail-ficha]:tracking-normal`}
              >
                <span
                  aria-hidden="true"
                  className="inline-block size-[0.55em] shrink-0 rounded-full bg-primary"
                />
                {eyebrow}
              </p>
            ) : null}
            <h2
              className={
                hideTitle
                  ? 'sr-only'
                  : 'mt-1 text-base font-medium in-[.detail-ficha]:text-xl in-[.detail-ficha]:font-semibold'
              }
            >
              {title}
            </h2>
          </div>
          <div className="flex items-center gap-2">
            {action}
            <DetailCopy text={copyMarkdown} label={copyLabel} />
          </div>
        </div>
      ) : (
        <h2 className="sr-only">{title}</h2>
      )}
      <div className="px-5 py-5 text-sm leading-7 text-foreground md:px-6">
        <MarkdownContent markdown={markdown} />
      </div>
    </section>
  );
}
