import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * The dashboard's badge set — the React replacement for `templates.ts`'s
 * `statusPill`/`reviewPill`/`verdictPill`. Each role keeps the tone the retired
 * pill carried (active = lime, superseded/needs_review = warn, archived = dim,
 * conflicts = danger) read through the semantic tokens, so a theme change moves
 * the badge with everything else.
 */

const STATUS_TONE: Record<string, string> = {
  active: 'border-primary/50 text-brand-accent',
  superseded: 'border-warn/50 text-warn',
  archived: 'text-muted-foreground',
  // The `memory_relations.status` vocabulary, rendered by the memories detail's
  // judgments section and by the judgments list. The retired status pill toned
  // these three from CSS; `ended`/`abandoned` had no rule there, so an untoned
  // key is the faithful default rather than an omission.
  pending: 'border-dashed text-muted-foreground',
  judged: 'border-primary/50 text-brand-accent',
  orphaned: 'border-destructive/50 text-destructive',
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <Badge variant="outline" className={cn('font-mono uppercase', STATUS_TONE[status], className)}>
      {status}
    </Badge>
  );
}

/** Rendered only when the derived review state is `needs_review`. */
export function ReviewBadge({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={cn('border-warn/50 font-mono text-warn', className)}>
      needs_review
    </Badge>
  );
}

/** Rendered beside an uncurated (`summary_final = 0`) session summary. */
export function RawBadge({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={cn('border-warn/50 font-mono text-warn', className)}>
      RAW
    </Badge>
  );
}

const VERDICT_TONE: Record<string, string> = {
  supersedes: 'border-warn/50 text-warn',
  conflicts_with: 'border-destructive/50 text-destructive',
  related: 'border-primary/50 text-brand-accent',
  compatible: 'border-primary/50 text-brand-accent',
  scoped: 'text-muted-foreground',
  not_conflict: 'text-muted-foreground',
  pending_conflict: 'border-warn/40 text-warn',
  superseded_by: 'border-warn/50 text-warn',
};

export function VerdictBadge({ kind, className }: { kind: string | null; className?: string }) {
  if (!kind) return <span className="text-muted-foreground">—</span>;
  return (
    <Badge variant="outline" className={cn('font-mono', VERDICT_TONE[kind], className)}>
      {kind}
    </Badge>
  );
}

/** Memory type, rendered in the list's `type` column. */
export function TypeBadge({ type, className }: { type: string; className?: string }) {
  return (
    <Badge variant="secondary" className={cn('font-mono text-muted-foreground', className)}>
      {type}
    </Badge>
  );
}
