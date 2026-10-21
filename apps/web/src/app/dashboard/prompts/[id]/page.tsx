import Link from 'next/link';
import { notFound } from 'next/navigation';

import { deletePrompt, undeletePrompt } from '../page';

import { ActionForm } from '@/components/dashboard/action-form';
import { ConfirmSubmit } from '@/components/dashboard/confirm-submit';
import { CsrfField } from '@/components/dashboard/csrf-field';
import { DetailCopy } from '@/components/dashboard/detail-copy';
import { DetailExpand } from '@/components/dashboard/detail-expand';
import type { DetailShareData } from '@/components/dashboard/detail-image';
import { DetailDisclosure, DetailLayout } from '@/components/dashboard/detail-layout';
import { DetailShare } from '@/components/dashboard/detail-share';
import { MarkdownPanel } from '@/components/dashboard/markdown-panel';
import { Flash, StatusPill, Time } from '@/components/dashboard/ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

export default async function PromptDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { repos } = getServices();
  const row = repos.prompts.findById(id);
  if (!row) notFound();

  const project = row.projectId ? repos.projects.findById(row.projectId) : undefined;
  const status = row.deletedAt ? 'deleted' : row.replaces?.length ? 'refined' : 'active';
  const tags = row.tags ?? [];
  const shareData: DetailShareData = {
    kind: 'prompt',
    label: 'Prompt',
    title: row.title,
    date: row.createdAt,
    byline: row.agent ? `Captured by ${row.agent}` : 'Captured prompt',
    projectName: project?.slug ?? '—',
    tags,
    content: { text: row.content, mode: 'markdown', label: 'Full content' },
  };
  const tag = (value: string, index: number) => (
    <span className="ficha-tag" key={index}>
      <span aria-hidden="true">#</span>
      {value}
    </span>
  );

  return (
    <DetailLayout
      presentation="ficha"
      title={row.title}
      backHref="/dashboard/prompts"
      backLabel="Prompts"
      contentLabel="Prompt content"
      badges={
        <>
          <StatusPill status={status} />
          {row.agent ? <Badge>{row.agent}</Badge> : null}
          <span className="ficha-byline">
            in <b>{project?.slug ?? '—'}</b>, captured <Time value={row.createdAt} />
          </span>
        </>
      }
      tags={
        tags.length > 0 ? (
          <div role="group" aria-label="Tags" className="ficha-tags">
            {tags.slice(0, 6).map(tag)}
            {tags.length > 6 ? (
              <DetailExpand
                label={`+${tags.length - 6}`}
                accessibleLabel={`Show all ${tags.length} tags`}
                className="ficha-extra-tags"
              >
                {tags.slice(6).map(tag)}
              </DetailExpand>
            ) : null}
          </div>
        ) : null
      }
      actionsLabel="Prompt actions"
      notices={
        row.deletedAt ? (
          <Flash tone="danger" label="SOFT-DELETED">
            Removed from the active list on <Time value={row.deletedAt} />. Restore it to make it
            visible again.
          </Flash>
        ) : null
      }
      metadata={
        <DetailDisclosure presentation="ficha" title="Properties">
          <dl>
            <dt>ID</dt>
            <dd>{row.id}</dd>
            <dt>Status</dt>
            <dd>
              <StatusPill status={status} />
            </dd>
            <dt>Project</dt>
            <dd>
              {project ? (
                <Link
                  href={`/dashboard/projects?q=${encodeURIComponent(project.slug)}`}
                  className="underline underline-offset-4 hover:text-primary"
                >
                  {project.slug}
                </Link>
              ) : (
                '—'
              )}
            </dd>
            <dt>Agent</dt>
            <dd>{row.agent ?? '—'}</dd>
            {tags.length === 0 ? (
              <>
                <dt>Tags</dt>
                <dd>—</dd>
              </>
            ) : null}
            <dt>Created</dt>
            <dd>
              <Time value={row.createdAt} />
            </dd>
            <dt>Session</dt>
            <dd>
              {row.sessionId ? (
                <Link
                  href={`/dashboard/sessions/${row.sessionId}`}
                  className="underline underline-offset-4 hover:text-primary"
                >
                  {row.sessionId}
                </Link>
              ) : (
                '—'
              )}
            </dd>
            <dt>Replaces</dt>
            <dd>
              {row.replaces?.length ? (
                <div className="flex flex-col gap-1">
                  {row.replaces.map((predecessor) => (
                    <Link
                      key={predecessor}
                      href={`/dashboard/prompts/${predecessor}`}
                      className="underline underline-offset-4 hover:text-primary"
                    >
                      {predecessor}
                    </Link>
                  ))}
                </div>
              ) : (
                '—'
              )}
            </dd>
          </dl>
        </DetailDisclosure>
      }
      primaryActions={
        <>
          <DetailCopy text={row.content} />
          <DetailShare data={shareData} />
          {row.deletedAt ? (
            <ActionForm action={undeletePrompt}>
              <CsrfField form="prompt.undelete" />
              <input type="hidden" name="id" value={row.id} />
              <Button type="submit">Undelete</Button>
            </ActionForm>
          ) : (
            <ActionForm action={deletePrompt}>
              <CsrfField form="prompt.delete" />
              <input type="hidden" name="id" value={row.id} />
              <ConfirmSubmit
                tone="danger"
                title="Soft-delete this prompt?"
                description="It is hidden from default lists, memory.context.recentPrompts, and memory.search_prompts; restorable via the Undelete action."
                confirmLabel="DELETE PROMPT"
              >
                <Button type="button" variant="destructive" size="sm">
                  Delete
                </Button>
              </ConfirmSubmit>
            </ActionForm>
          )}
        </>
      }
    >
      <MarkdownPanel
        presentation="reading"
        hideToolbar
        title="Full prompt"
        markdown={row.content}
      />
      <footer className="ficha-footer">
        <span>
          Captured <Time value={row.createdAt} />
        </span>
      </footer>
    </DetailLayout>
  );
}
