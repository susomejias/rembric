import { EmptyState } from '@/components/dashboard/empty-state';
import { SectionCard } from '@/components/dashboard/overview-section';

/**
 * The `ACTIVITY · 7 DAYS` card and the compact `sparkline` the stat strip's
 * `TOTAL MEMORIES` card carries — both read the same seven-day series, which is
 * the retired home's `sevenDayActivity` bucket (UTC days, oldest first).
 *
 * The retired card printed an ASCII bar chart inside a `<pre>`; the area chart
 * plus the labelled counts under it carry the same information legibly, and no
 * chart library is adopted for one 7-point series.
 */

/** Weekday of each bucket, oldest first: the retired bar chart's `MON`..`SUN` labels. */
function weekdayLabels(count: number): string[] {
  const days = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  const labels: string[] = [];
  const today = new Date();
  for (let i = count - 1; i >= 0; i--) {
    const day = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    labels.push(days[(day.getUTCDay() + 6) % 7] ?? '');
  }
  return labels;
}

export function Sparkline({ data }: { data: number[] }) {
  if (data.length === 0) return <span className="text-muted-foreground">·</span>;
  const width = 64;
  const height = 16;
  const max = Math.max(...data, 1);
  const step = data.length > 1 ? width / (data.length - 1) : 0;
  const points = data
    .map((value, i) => `${(i * step).toFixed(1)},${(height - (value / max) * height).toFixed(1)}`)
    .join(' ');
  return (
    <svg
      className="text-brand-accent"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      <polyline fill="none" stroke="currentColor" strokeWidth="1.5" points={points} />
    </svg>
  );
}

function ActivityChart({ data }: { data: number[] }) {
  const max = Math.max(...data, 1);
  const step = data.length > 1 ? 100 / (data.length - 1) : 0;
  const points = data.map(
    (value, i) => `${(i * step).toFixed(2)},${(32 - (value / max) * 32).toFixed(2)}`,
  );
  const area = `0,32 ${points.join(' ')} 100,32`;
  return (
    <svg
      viewBox="0 0 100 32"
      preserveAspectRatio="none"
      className="h-24 w-full text-brand-accent"
      role="img"
      aria-label={`Memories created per day, last 7 days: ${data.join(', ')}`}
    >
      <polygon points={area} className="fill-primary/15" />
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function OverviewActivityCard({ data }: { data: number[] }) {
  const labels = weekdayLabels(data.length);
  const total = data.reduce((acc, value) => acc + value, 0);

  return (
    <SectionCard name="ACTIVITY · 7 DAYS" meta="MEMORIES CREATED · PER DAY">
      {data.length === 0 ? (
        <div className="p-4">
          <EmptyState>NO ACTIVITY RECORDED</EmptyState>
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-4">
          <ActivityChart data={data} />
          <ol className="grid grid-cols-7 gap-1 font-mono text-[0.66rem] tracking-[0.12em] uppercase">
            {data.map((value, i) => (
              <li key={`${labels[i] ?? ''}-${i}`} className="flex flex-col items-center gap-0.5">
                <span className="text-muted-foreground">{labels[i]}</span>
                <span className="text-sm font-semibold tabular-nums">{value}</span>
              </li>
            ))}
          </ol>
          <p className="font-mono text-[0.66rem] tracking-[0.12em] text-muted-foreground uppercase">
            {total} created · peak {Math.max(...data, 0)} in a day
          </p>
        </div>
      )}
    </SectionCard>
  );
}
