import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { ActionForm, type ActionState } from '@/components/dashboard/action-form';
import { ConfirmSubmit } from '@/components/dashboard/confirm-submit';
import { CsrfField } from '@/components/dashboard/csrf-field';
import { DetailCopy } from '@/components/dashboard/detail-copy';
import { DetailDisclosure } from '@/components/dashboard/detail-layout';
import {
  JudgmentRelationIcon,
  JudgmentVerdict,
  judgmentPresentation,
} from '@/components/dashboard/judgment-verdict';
import { MarkdownContent } from '@/components/dashboard/markdown-content';
import { shortId } from '@/components/dashboard/support';
import { BackLink, LABEL, Page, StatusPill, Time } from '@/components/dashboard/ui';
import { Button } from '@/components/ui/button';
import { guardAction, guardFailure } from '@/lib/actions/guard';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

const ORPHAN_FORM = 'judgment.orphan';

async function orphanJudgment(_prev: ActionState, formData: FormData): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, ORPHAN_FORM);
  if (!guard.ok) return guardFailure(guard);

  if (!guard.services.relations.orphanByOperator(readField(formData, 'judgmentId'))) {
    return { error: 'Judgment not found or already closed.' };
  }
  redirect('/dashboard/judgments');
}

function readField(form: FormData, name: string): string {
  const value = form.get(name);
  return (typeof value === 'string' ? value : '').trim();
}

export default async function JudgmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { repos } = getServices();
  const row = repos.relations.adminGetWithContent(id);
  if (!row) notFound();

  const presentation = judgmentPresentation(row);

  return (
    <Page className="detail-layout judgment-detail">
      <BackLink href="/dashboard/judgments" label="Back to judgments" />
      <header className="mt-7 mb-9 flex flex-col items-start justify-between gap-5 sm:flex-row">
        <div className="min-w-0">
          <h1 className="text-[25px] leading-tight font-semibold tracking-tight wrap-anywhere sm:text-3xl">
            {presentation.title}
          </h1>
          <div className="mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-[var(--chart-2)]">
            <StatusPill status={row.status} />
            <span>
              Created <Time value={row.createdAt} />
            </span>
            {row.markedByKind || row.markedByActor ? (
              <span className="min-w-0 wrap-anywhere">
                Marked by {[row.markedByKind, row.markedByActor].filter(Boolean).join(' · ')}
              </span>
            ) : null}
          </div>
        </div>
        {row.status === 'pending' ? (
          <div role="group" aria-label="Judgment actions" className="shrink-0">
            <ActionForm action={orphanJudgment}>
              <CsrfField form={ORPHAN_FORM} />
              <input type="hidden" name="judgmentId" value={row.judgmentId} />
              <ConfirmSubmit
                tone="danger"
                title="Mark this judgment as orphaned?"
                description="It will be removed from the pending queue and won't be re-judged automatically."
                confirmLabel="MARK ORPHANED"
              >
                <Button type="button" variant="destructive" size="sm">
                  Mark orphaned
                </Button>
              </ConfirmSubmit>
            </ActionForm>
          </div>
        ) : null}
      </header>

      <JudgmentVerdict row={row} />

      <section
        aria-label="Compared memories"
        className="mt-8 grid min-w-0 grid-cols-1 min-[900px]:grid-cols-[minmax(0,1fr)_56px_minmax(0,1fr)]"
      >
        {[
          {
            label: 'Source',
            id: row.sourceId,
            title: row.sourceTitle,
            content: row.sourceContent,
            copyLabel: 'Copy source',
          },
          {
            label: 'Target',
            id: row.targetId,
            title: row.targetTitle,
            content: row.targetContent,
            copyLabel: 'Copy target',
          },
        ].map((memory, index) => (
          <div key={memory.label} className="contents">
            {index === 1 ? (
              <div
                aria-hidden="true"
                className="relative flex h-[60px] items-center justify-center min-[900px]:h-auto min-[900px]:items-start min-[900px]:pt-[52px]"
              >
                <span className="absolute inset-y-0 left-1/2 w-px bg-border min-[900px]:inset-y-10" />
                <span className="relative rounded-full bg-background p-1.5">
                  <JudgmentRelationIcon relation={row.relation} status={row.status} />
                </span>
              </div>
            ) : null}
            <article
              aria-label={`${memory.label} memory`}
              className="min-w-0 overflow-hidden rounded-[16px] border border-border bg-card"
            >
              <header className="border-b border-border px-5 pt-[22px] pb-[18px] sm:px-[26px]">
                <div className="flex items-center justify-between gap-2">
                  <span className={`flex items-center gap-2 text-primary ${LABEL}`}>
                    <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
                    {memory.label}
                  </span>
                  <div className="[&_button]:h-[30px] [&_button]:px-2.5 [&_button]:font-mono [&_button]:text-[10px] [&_button]:tracking-wider [&_button]:uppercase">
                    <DetailCopy text={memory.content} label={memory.copyLabel} />
                  </div>
                </div>
                <h2 className="mt-3.5 mb-2 text-xl leading-[1.35] font-semibold tracking-tight wrap-anywhere">
                  <Link
                    href={`/dashboard/memories/${memory.id}`}
                    className="group inline-flex items-start gap-2 hover:text-primary"
                  >
                    {memory.title}
                    <ArrowUpRight
                      aria-hidden="true"
                      className="mt-1 size-4 shrink-0 text-[var(--chart-2)] group-hover:text-primary"
                    />
                  </Link>
                </h2>
                <p className="font-mono text-xs text-[var(--chart-2)]">{shortId(memory.id)}</p>
              </header>
              <div className="px-5 pt-[22px] pb-[26px] text-base leading-7 wrap-anywhere sm:px-[26px]">
                <MarkdownContent markdown={memory.content} />
              </div>
            </article>
          </div>
        ))}
      </section>

      <div className="mt-8">
        <DetailDisclosure presentation="ficha" title="Properties">
          <dl>
            <dt>Judgment id</dt>
            <dd>{row.judgmentId}</dd>
            <dt>Relation id</dt>
            <dd>{row.id}</dd>
            <dt>Status</dt>
            <dd>
              <StatusPill status={row.status} />
            </dd>
            <dt>Verdict</dt>
            <dd>{row.relation ?? '—'}</dd>
            <dt>Confidence</dt>
            <dd>{row.confidence !== null ? row.confidence.toFixed(2) : '—'}</dd>
            <dt>Marked by</dt>
            <dd>{`${row.markedByKind ?? '—'}${row.markedByActor ? ` · ${row.markedByActor}` : ''}`}</dd>
            <dt>Created</dt>
            <dd>
              <Time value={row.createdAt} />
            </dd>
            <dt>Judged</dt>
            <dd>
              <Time value={row.judgedAt} />
            </dd>
          </dl>
        </DetailDisclosure>
      </div>
    </Page>
  );
}
