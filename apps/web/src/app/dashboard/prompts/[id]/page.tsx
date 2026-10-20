import Link from 'next/link';
import { notFound } from 'next/navigation';

import { deletePrompt, undeletePrompt } from '../page';

import { ActionForm } from '@/components/dashboard/action-form';
import { ConfirmSubmit } from '@/components/dashboard/confirm-submit';
import { CsrfField } from '@/components/dashboard/csrf-field';
import { DetailDisclosure, DetailLayout } from '@/components/dashboard/detail-layout';
import { MarkdownPanel } from '@/components/dashboard/markdown-panel';
import { Flash, MetaRow, StatusPill, Time } from '@/components/dashboard/ui';
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

  return (
    <DetailLayout
      title={row.title}
      backHref="/dashboard/prompts"
      backLabel="BACK TO PROMPTS"
      contentLabel="Prompt content"
      badges={<StatusPill status={status} />}
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
        <DetailDisclosure title="Details" inspector>
          <dl className="detail-fields">
            <MetaRow k="ID" v={row.id} mono />
            <MetaRow k="Status" v={<StatusPill status={status} />} />
            <MetaRow
              k="Project"
              v={
                project ? (
                  <Link
                    href={`/dashboard/projects?q=${encodeURIComponent(project.slug)}`}
                    className="hover:text-primary"
                  >
                    {project.slug}
                  </Link>
                ) : (
                  '—'
                )
              }
            />
            <MetaRow k="Agent" v={row.agent ?? '—'} />
            <MetaRow k="Tags" v={row.tags?.length ? row.tags.join(' · ') : '—'} />
            <MetaRow k="Created" v={<Time value={row.createdAt} />} mono />
            <MetaRow
              k="Session"
              v={
                row.sessionId ? (
                  <Link
                    href={`/dashboard/sessions/${row.sessionId}`}
                    className="hover:text-primary"
                  >
                    {row.sessionId}
                  </Link>
                ) : (
                  '—'
                )
              }
              mono
            />
            <MetaRow
              k="Replaces"
              v={
                row.replaces?.length ? (
                  <div className="flex flex-col gap-1">
                    {row.replaces.map((predecessor) => (
                      <Link
                        key={predecessor}
                        href={`/dashboard/prompts/${predecessor}`}
                        className="hover:text-primary"
                      >
                        {predecessor}
                      </Link>
                    ))}
                  </div>
                ) : (
                  '—'
                )
              }
              mono
            />
          </dl>
        </DetailDisclosure>
      }
      actions={
        row.deletedAt ? (
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
        )
      }
    >
      <MarkdownPanel
        presentation="reading"
        hideTitle
        title="Full prompt"
        markdown={row.content}
        copyMarkdown={row.content}
      />
    </DetailLayout>
  );
}
