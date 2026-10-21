import type { MemoryRelation, RelationKind } from '@rembric/db';
import {
  ArrowRight,
  Check,
  CircleMinus,
  Clock3,
  Layers,
  Link2,
  ShieldCheck,
  X,
  type LucideIcon,
} from 'lucide-react';

import { DetailDisclosure } from './detail-layout';
import { LABEL } from './ui';

import { Progress } from '@/components/ui/progress';

const VERDICTS = {
  supersedes: {
    label: 'Supersedes',
    title: 'Source supersedes Target',
    description: 'Source supersedes Target.',
    icon: ArrowRight,
    tone: 'amber',
  },
  conflicts_with: {
    label: 'Conflicts with',
    title: 'Conflicting memories',
    description:
      'A conflict was recorded between these memories. No winner is selected by this verdict.',
    icon: X,
    tone: 'amber',
  },
  related: {
    label: 'Related',
    title: 'Related memories',
    description: 'A relationship was recorded between these memories.',
    icon: Link2,
    tone: 'lime',
  },
  compatible: {
    label: 'Compatible',
    title: 'Compatible memories',
    description: 'These memories were judged to be compatible.',
    icon: Check,
    tone: 'lime',
  },
  scoped: {
    label: 'Scoped',
    title: 'Scoped relationship',
    description: 'Scoped relationship recorded. See the reason for its context.',
    icon: Layers,
    tone: 'lime',
  },
  not_conflict: {
    label: 'Not a conflict',
    title: 'No conflict between memories',
    description: 'Source and Target were judged not to conflict.',
    icon: ShieldCheck,
    tone: 'lime',
  },
} satisfies Record<
  RelationKind,
  { label: string; title: string; description: string; icon: LucideIcon; tone: 'lime' | 'amber' }
>;

const TONES = {
  lime: 'border-primary/40 bg-primary/10 text-primary',
  amber: 'border-warn/40 bg-warn/10 text-warn',
  dim: 'border-border bg-muted text-[var(--chart-2)]',
};

export function judgmentPresentation(row: Pick<MemoryRelation, 'relation' | 'status'>) {
  if (row.relation !== null) return VERDICTS[row.relation];
  return row.status === 'pending'
    ? {
        label: 'Awaiting verdict',
        title: 'Compare memories',
        description: 'This comparison has no recorded verdict yet.',
        icon: Clock3,
        tone: 'dim' as const,
      }
    : {
        label: 'No verdict recorded',
        title: 'Unjudged comparison',
        description: 'This comparison is closed without a recorded verdict.',
        icon: CircleMinus,
        tone: 'dim' as const,
      };
}

export function JudgmentRelationIcon({
  relation,
  status,
}: Pick<MemoryRelation, 'relation' | 'status'>) {
  const presentation = judgmentPresentation({ relation, status });
  const Icon = presentation.icon;
  return (
    <span
      className={`inline-flex size-9 shrink-0 items-center justify-center rounded-full border ${TONES[presentation.tone]}`}
    >
      <Icon aria-hidden="true" className="size-4" />
    </span>
  );
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

export function JudgmentVerdict({
  row,
}: {
  row: Pick<MemoryRelation, 'relation' | 'status' | 'reason' | 'confidence' | 'evidence'>;
}) {
  const presentation = judgmentPresentation(row);
  const evidence = evidencePretty(row.evidence);
  return (
    <section
      aria-label="Verdict"
      className="grid min-w-0 overflow-hidden rounded-[16px] border border-border bg-card min-[900px]:grid-cols-[280px_minmax(0,1fr)]"
    >
      <div className="border-b border-border p-5 sm:p-7 min-[900px]:border-r min-[900px]:border-b-0">
        <p className={`mb-4 flex items-center gap-2 text-primary ${LABEL}`}>
          <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
          Verdict
        </p>
        <div className="flex items-center gap-3">
          <JudgmentRelationIcon relation={row.relation} status={row.status} />
          <h2 className="text-[26px] leading-tight font-semibold tracking-tight">
            {presentation.label}
          </h2>
        </div>
        <p className="mt-2 text-sm leading-6 text-[var(--chart-2)]">{presentation.description}</p>
        {row.confidence !== null ? (
          <div className="mt-6">
            <p className={`mb-2 flex items-center justify-between text-[var(--chart-2)] ${LABEL}`}>
              Confidence
              <span className="text-[13px] tracking-normal text-foreground">
                {row.confidence.toFixed(2)}
              </span>
            </p>
            <Progress
              aria-label="Confidence"
              aria-valuetext={row.confidence.toFixed(2)}
              value={row.confidence * 100}
              className="h-1.5"
            />
          </div>
        ) : null}
      </div>
      <div className="min-w-0 p-5 sm:px-8 sm:py-7">
        <section aria-label="Reason">
          <h3 className={`mb-3 flex items-center gap-2 text-primary ${LABEL}`}>
            <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
            Reason
          </h3>
          <p className="max-w-[64ch] text-[17px] leading-[1.7] whitespace-pre-wrap wrap-anywhere sm:text-lg">
            {row.reason ?? 'No reason recorded.'}
          </p>
        </section>
        <div className="mt-5 [&>details]:py-3">
          <DetailDisclosure presentation="ficha" title="Evidence">
            {evidence !== null ? (
              <pre
                tabIndex={0}
                className="rounded-xl border border-border bg-background p-4 font-mono text-xs leading-6 whitespace-pre-wrap! wrap-anywhere! text-[var(--chart-2)]"
              >
                {evidence}
              </pre>
            ) : (
              <p className="text-sm text-[var(--chart-2)]">No evidence recorded.</p>
            )}
          </DetailDisclosure>
        </div>
        {row.status !== 'pending' ? (
          <p className="mt-1 text-xs text-[var(--chart-2)]">
            No actions available — this judgment is closed.
          </p>
        ) : null}
      </div>
    </section>
  );
}
