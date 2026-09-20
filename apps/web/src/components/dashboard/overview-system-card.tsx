import type { SystemInfo } from '@/components/dashboard/overview-data';
import { SectionCard } from '@/components/dashboard/overview-section';
import { cn } from '@/lib/utils';

/**
 * The `SYSTEM` card — the deployment facts the retired home read on every
 * render: the database path and its on-disk size, the FTS index shape, the
 * address the MCP surface answers on, and the Node version.
 */
export function OverviewSystemCard({ info }: { info: SystemInfo }) {
  return (
    <SectionCard name="SYSTEM" meta="SQLITE · NODE · MCP">
      <div className="flex flex-col px-4 py-2">
        <SystemRow label="DB FILE" value={info.dbPath} tone="accent" />
        <SystemRow label="DB SIZE" value={info.dbSize} />
        <SystemRow label="FTS INDEX" value="memory_fts · contentless" />
        <SystemRow label="MCP SERVER" value={info.host} tone="accent" />
        <SystemRow label="NODE" value={info.node} />
      </div>
    </SectionCard>
  );
}

function SystemRow({
  label,
  value,
  tone = 'fg',
}: {
  label: string;
  value: string;
  tone?: 'fg' | 'accent';
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b py-2 last:border-b-0">
      <span className="flex shrink-0 items-center gap-2 font-mono text-[0.66rem] tracking-[0.12em] text-muted-foreground uppercase">
        <span
          aria-hidden
          className={cn(
            'size-1.5 rounded-[2px]',
            tone === 'accent' ? 'bg-brand-accent' : 'bg-muted-foreground/40',
          )}
        />
        {label}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 text-right font-mono text-xs break-all',
          tone === 'accent' ? 'text-brand-accent' : 'text-foreground',
        )}
      >
        {value}
      </span>
    </div>
  );
}
