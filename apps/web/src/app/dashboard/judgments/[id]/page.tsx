import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { ActionForm, type ActionState } from '@/components/dashboard/action-form';
import { ConfirmSubmit } from '@/components/dashboard/confirm-submit';
import { CsrfField } from '@/components/dashboard/csrf-field';
import { DetailDisclosure, DetailLayout } from '@/components/dashboard/detail-layout';
import { MarkdownPanel } from '@/components/dashboard/markdown-panel';
import { shortId } from '@/components/dashboard/support';
import { Pill, StatusPill, Time } from '@/components/dashboard/ui';
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

function evidencePretty(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2) ?? value;
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2) ?? null;
}

export default async function JudgmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { repos } = getServices();

  const row = repos.relations.adminGetWithContent(id);
  if (!row) notFound();

  const evidence = evidencePretty(row.evidence);

  return (
    <DetailLayout
      presentation="ficha"
      title={`Judgment ${shortId(row.id)}`}
      backHref="/dashboard/judgments"
      backLabel="Judgments"
      contentLabel="Compared memories"
      badges={
        <>
          <StatusPill status={row.status} />
          {row.relation !== null ? <Pill tone="lime">{row.relation}</Pill> : null}
          <span className="ficha-byline">
            Created <Time value={row.createdAt} />
          </span>
        </>
      }
      metadata={
        <DetailDisclosure presentation="ficha" title="Properties">
          <dl>
            <dt>Judgment id</dt>
            <dd>{row.judgmentId}</dd>
            <dt>Status</dt>
            <dd>
              <StatusPill status={row.status} />
            </dd>
            <dt>Verdict</dt>
            <dd>
              <Pill tone={row.relation === null ? 'dim' : 'lime'}>{row.relation ?? 'pending'}</Pill>
            </dd>
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
      }
      secondary={
        <>
          <DetailDisclosure presentation="ficha" title="Reason">
            <p className="text-base whitespace-pre-wrap wrap-anywhere text-muted-foreground">
              {row.reason ?? '—'}
            </p>
          </DetailDisclosure>
          <DetailDisclosure presentation="ficha" title="Evidence">
            {evidence !== null ? (
              <pre
                tabIndex={0}
                className="font-mono text-sm leading-6 whitespace-pre-wrap! wrap-anywhere! text-muted-foreground"
              >
                {evidence}
              </pre>
            ) : (
              <p className="text-muted-foreground">—</p>
            )}
          </DetailDisclosure>
        </>
      }
      actionsLabel="Judgment actions"
      primaryActions={
        row.status === 'pending' ? (
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
        ) : null
      }
      notices={
        row.status !== 'pending' ? (
          <p className="mb-4 text-sm text-muted-foreground">
            No actions available — this judgment is closed.
          </p>
        ) : null
      }
    >
      <div className="space-y-8">
        <MarkdownPanel
          presentation="reading"
          eyebrow="Source"
          title={row.sourceTitle}
          markdown={row.sourceContent}
          copyLabel="Copy source"
          action={
            <Link
              href={`/dashboard/memories/${row.sourceId}`}
              className="font-mono text-[11px] uppercase tracking-[.14em] text-primary hover:underline"
            >
              {shortId(row.sourceId)} →
            </Link>
          }
        />

        <MarkdownPanel
          presentation="reading"
          eyebrow="Target"
          title={row.targetTitle}
          markdown={row.targetContent}
          copyLabel="Copy target"
          action={
            <Link
              href={`/dashboard/memories/${row.targetId}`}
              className="font-mono text-[11px] uppercase tracking-[.14em] text-primary hover:underline"
            >
              {shortId(row.targetId)} →
            </Link>
          }
        />
      </div>
    </DetailLayout>
  );
}
