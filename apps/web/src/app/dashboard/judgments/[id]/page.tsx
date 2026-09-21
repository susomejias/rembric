import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { ActionForm, type ActionState } from '@/components/dashboard/action-form';
import { ConfirmSubmit } from '@/components/dashboard/confirm-submit';
import { CsrfField } from '@/components/dashboard/csrf-field';
import { MarkdownPanel } from '@/components/dashboard/markdown-panel';
import { shortId } from '@/components/dashboard/support';
import {
  BackLink,
  Kv,
  KvGrid,
  Page,
  Pill,
  SectionBar,
  StatusPill,
  Time,
  ViewHead,
} from '@/components/dashboard/ui';
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
    <Page>
      <ViewHead title={`Rembric Judgment ${shortId(row.id)}.`} hl="Rembric" />

      <div className="mt-4 mb-5">
        <BackLink href="/dashboard/judgments" label="BACK TO JUDGMENTS" />
      </div>

      <KvGrid>
        <Kv k="Status" v={<StatusPill status={row.status} />} />
        <Kv
          k="Verdict"
          v={<Pill tone={row.relation === null ? 'dim' : 'lime'}>{row.relation ?? 'pending'}</Pill>}
        />
        <Kv k="Confidence" v={row.confidence !== null ? row.confidence.toFixed(2) : '—'} />
        <Kv
          k="Marked by"
          v={`${row.markedByKind ?? '—'}${row.markedByActor ? ` · ${row.markedByActor}` : ''}`}
        />
        <Kv k="Created" v={<Time value={row.createdAt} />} mono />
        <Kv k="Judged" v={<Time value={row.judgedAt} />} mono />
      </KvGrid>

      <MarkdownPanel
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

      <SectionBar name="Reason" />
      <p className="mb-6 text-sm text-muted-foreground">{row.reason ?? '—'}</p>

      <SectionBar name="Evidence" />
      {evidence !== null ? (
        <pre className="mb-6 overflow-x-auto border border-border bg-muted p-3 font-mono text-xs leading-5">
          {evidence}
        </pre>
      ) : (
        <p className="mb-6 text-muted-foreground">—</p>
      )}

      <SectionBar name="Judgment id" />
      <p className="mb-6 font-mono text-xs">{row.judgmentId}</p>

      <SectionBar name="Actions" />
      {row.status === 'pending' ? (
        <ActionForm action={orphanJudgment}>
          <CsrfField form={ORPHAN_FORM} />
          <input type="hidden" name="judgmentId" value={row.judgmentId} />
          <ConfirmSubmit
            tone="danger"
            title="Mark this judgment as orphaned?"
            description="It will be removed from the pending queue and won't be re-judged automatically."
            confirmLabel="MARK ORPHANED"
          >
            <Button type="button" variant="outline" size="sm">
              MARK ORPHANED
            </Button>
          </ConfirmSubmit>
        </ActionForm>
      ) : (
        <p className="text-muted-foreground">No actions available — this judgment is closed.</p>
      )}
    </Page>
  );
}
