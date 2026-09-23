'use client';

import Link from 'next/link';

import { ActionForm, type ActionState } from '@/components/dashboard/action-form';
import { ConfirmSubmit } from '@/components/dashboard/confirm-submit';
import { shortId, truncate } from '@/components/dashboard/support';
import { Pill, Tag, Time } from '@/components/dashboard/ui';
import { DataTable, type DataTableColumn } from '@/components/spectrumui/data-table';
import { Button } from '@/components/ui/button';

export interface PromptRowData {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly project: string;
  readonly sessionId: string | null;
  readonly agent: string;
  readonly tags: readonly string[];
  readonly status: string;
  readonly createdAt: Date;
  readonly deleted: boolean;
}

export interface PromptServerActions {
  remove: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
  restore: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
}

export interface PromptCsrfTokens {
  readonly remove: string | null;
  readonly restore: string | null;
}

export function PromptsTable({
  rows,
  actions,
  csrf,
}: {
  rows: readonly PromptRowData[];
  actions: PromptServerActions;
  csrf: PromptCsrfTokens;
}) {
  const columns: DataTableColumn<PromptRowData>[] = [
    {
      id: 'prompt',
      header: 'Prompt',
      sortable: true,
      value: (row) => row.title,
      cell: (row) => (
        <div className="flex max-w-[280px] min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-foreground">
            {truncate(row.title, 60)}
          </span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {row.project} · <Time value={row.createdAt} />
          </span>
        </div>
      ),
    },
    {
      id: 'session',
      header: 'Session',
      sortable: true,
      hideBelow: 'lg',
      value: (row) => row.sessionId ?? '',
      cell: (row) =>
        row.sessionId ? (
          <Link
            href={`/dashboard/sessions/${row.sessionId}`}
            className="font-mono text-xs text-muted-foreground hover:text-primary"
          >
            {shortId(row.sessionId)}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'agent',
      header: 'Agent',
      sortable: true,
      hideBelow: 'md',
      value: (row) => row.agent,
      cell: (row) => <span className="text-muted-foreground">{row.agent}</span>,
    },
    {
      id: 'tags',
      header: 'Tags',
      hideBelow: 'lg',
      value: (row) => row.tags.join(' '),
      cell: (row) =>
        row.tags.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {row.tags.map((tag) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
          </div>
        ),
    },
    {
      id: 'status',
      header: 'Status',
      sortable: true,
      value: (row) => row.status,
      cell: (row) => <Pill tone={row.status === 'deleted' ? 'dim' : 'lime'}>{row.status}</Pill>,
    },
    {
      id: 'content',
      header: 'Content',
      hideBelow: 'md',
      value: (row) => row.content,
      cell: (row) => (
        <span className="block max-w-[360px] truncate text-muted-foreground">
          {truncate(row.content, 160)}
        </span>
      ),
    },
  ];

  return (
    <DataTable
      data={rows}
      columns={columns}
      rowId={(row) => row.id}
      rowLabel={(row) => `${row.title} — ${row.project}`}
      caption="Captured prompts with scope, session, agent, tags and status"
      variant="panel"
      density="default"
      emptyState={
        <div className="px-5 py-10 text-center text-sm text-muted-foreground">
          NO PROMPT MATCHES THIS FILTER
        </div>
      }
      rowActions={(row) => <PromptRowActions row={row} actions={actions} csrf={csrf} />}
    />
  );
}

function PromptRowActions({
  row,
  actions,
  csrf,
}: {
  row: PromptRowData;
  actions: PromptServerActions;
  csrf: PromptCsrfTokens;
}) {
  if (row.deleted) {
    return (
      <ActionForm action={actions.restore}>
        <input type="hidden" name="csrf" value={csrf.restore ?? ''} />
        <input type="hidden" name="id" value={row.id} />
        <Button type="submit" variant="outline" size="sm">
          Undelete
        </Button>
      </ActionForm>
    );
  }

  return (
    <ActionForm action={actions.remove}>
      <input type="hidden" name="csrf" value={csrf.remove ?? ''} />
      <input type="hidden" name="id" value={row.id} />
      <ConfirmSubmit
        tone="warn"
        title="Soft-delete this prompt?"
        description="It is hidden from default lists, memory.context.recentPrompts, and memory.search_prompts; restorable via the Undelete action."
        confirmLabel="DELETE PROMPT"
      >
        <Button type="button" variant="outline" size="sm">
          Delete
        </Button>
      </ConfirmSubmit>
    </ActionForm>
  );
}
