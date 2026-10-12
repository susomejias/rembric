'use client';

import type { MemoryType, RelationKind, WrappedStats } from '@rembric/db';
import { ArrowRight, ChevronDown, Pause, Play, Share2, ShieldCheck, X } from 'lucide-react';
import { animate, AnimatePresence, motion, useReducedMotion } from 'motion/react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';

import {
  createWrappedImage,
  formatWrappedCount,
  wrappedEntityMemoryRows,
  WRAPPED_IMAGE_SIZES,
  WRAPPED_MONTHS,
  WRAPPED_TYPE_LABELS as TYPE_LABELS,
  type WrappedImageFormat,
} from './wrapped-image';

import { NumberTicker } from '@/components/motion/number-ticker';
import { cn } from '@/lib/utils';

const TITLES = [
  'Your year. In memory.',
  'Worth remembering.',
  'Your building crew.',
  'What you kept.',
  'Context, connected.',
  'Your technical universe.',
  'Where you focused.',
  'Day after day.',
  'Your high point.',
  'Take it with you.',
];
const JUDGMENT_LABELS: Record<RelationKind, string> = {
  supersedes: 'Replaces earlier knowledge',
  conflicts_with: 'Conflicts identified',
  compatible: 'Compatible knowledge',
  related: 'Related memories',
  scoped: 'Different contexts',
  not_conflict: 'Not conflicting',
};
const DAY_MS = 86_400_000;
const buttonClass =
  'flex min-h-11 min-w-11 items-center justify-center rounded-[10px] bg-secondary text-foreground transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary disabled:opacity-30';

export function Wrapped({ data, years }: { data: WrappedStats; years: number[] }) {
  const [slide, setSlide] = useState(0);
  const [paused, setPaused] = useState(false);
  const [held, setHeld] = useState(false);
  const progress = useRef<HTMLSpanElement>(null);
  const pointerStart = useRef<{ x: number; y: number; at: number } | null>(null);
  const playback = useRef<ReturnType<typeof animate> | null>(null);
  const reduce = useReducedMotion();
  const router = useRouter();
  const close = useRef<HTMLAnchorElement>(null);
  const hasActivity = data.memories + data.sessions + data.judgments > 0;
  const focusHeading = useCallback((node: HTMLHeadingElement | null) => {
    node?.closest('.wrapped-content')?.scrollTo({ top: 0 });
    if (!document.activeElement?.closest('header')) node?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const release = () => setHeld(false);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
  }, []);
  useEffect(() => {
    if (reduce) setPaused(true);
  }, [reduce]);
  useEffect(() => {
    if (!hasActivity || slide === TITLES.length - 1 || !progress.current) return;
    const controls = animate(
      progress.current,
      { scaleX: [0, 1] },
      {
        duration: 7,
        ease: 'linear',
        onComplete: () => setSlide((current) => Math.min(current + 1, TITLES.length - 1)),
      },
    );
    playback.current = controls;
    return () => {
      controls.stop();
      playback.current = null;
    };
  }, [slide, hasActivity, reduce]);
  useEffect(() => {
    const update = () => {
      if (paused || held || document.hidden) playback.current?.pause();
      else playback.current?.play();
    };
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, [slide, paused, held, reduce]);
  const peak = Math.max(...data.months);
  const peakMonth = data.months.indexOf(peak);
  const types = (Object.entries(data.types) as [MemoryType, number][])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  function navigate(event: KeyboardEvent<HTMLElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close.current?.click();
      return;
    }
    if (
      event.target instanceof HTMLElement &&
      event.target.closest('select, input, textarea, [role="radiogroup"]')
    )
      return;
    if (!hasActivity) return;
    if (
      event.key === ' ' &&
      !(event.target instanceof Element && event.target.closest('a, button'))
    ) {
      event.preventDefault();
      setPaused((value) => !value);
      return;
    }
    const next =
      event.key === 'ArrowRight'
        ? slide + 1
        : event.key === 'ArrowLeft'
          ? slide - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? TITLES.length - 1
              : null;
    if (next !== null) {
      event.preventDefault();
      setPaused(true);
      setSlide(Math.min(TITLES.length - 1, Math.max(0, next)));
    }
  }

  function navigateTap(event: MouseEvent<HTMLElement>) {
    if (
      event.target instanceof Element &&
      event.target.closest('a, button, input, select, textarea, label')
    )
      return;
    const start = pointerStart.current;
    pointerStart.current = null;
    if (
      start &&
      (performance.now() - start.at > 300 ||
        Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10)
    )
      return;
    if (window.getSelection()?.isCollapsed === false) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const direction = event.clientX < bounds.left + bounds.width / 2 ? -1 : 1;
    setSlide((current) => Math.min(TITLES.length - 1, Math.max(0, current + direction)));
  }

  return (
    <main className="wrapped-stage" onKeyDown={navigate}>
      <article
        className="wrapped-shell"
        data-paused={paused || held || slide === TITLES.length - 1}
        aria-label={`Rembric Wrapped ${data.year}`}
      >
        {hasActivity && (
          <div
            className="mb-5 flex gap-1"
            role="progressbar"
            aria-label="Wrapped progress"
            aria-valuemin={1}
            aria-valuemax={TITLES.length}
            aria-valuenow={slide + 1}
          >
            {TITLES.map((title, i) => (
              <span
                key={title}
                className={cn(
                  'h-1 flex-1 overflow-hidden rounded-full',
                  i === slide ? 'bg-primary/20' : 'bg-secondary',
                )}
              >
                <span
                  key={slide}
                  ref={i === slide ? progress : undefined}
                  className="block h-full origin-left bg-primary"
                  style={{
                    transform:
                      i < slide || (i === slide && slide === TITLES.length - 1)
                        ? 'scaleX(1)'
                        : 'scaleX(0)',
                  }}
                />
              </span>
            ))}
          </div>
        )}
        <header className="flex items-center justify-between gap-3">
          <Link
            href="/dashboard#wrapped-entry"
            className="flex min-h-11 items-center gap-2 text-base font-semibold"
            aria-label="Rembric overview"
          >
            <Image src="/dashboard/assets/logo-transparent.png" alt="" width={28} height={28} />
            rembric
          </Link>
          <form action="/dashboard/wrapped" className="relative ml-auto flex items-center">
            <label className="sr-only" htmlFor="wrapped-year">
              Wrapped year
            </label>
            <select
              id="wrapped-year"
              name="year"
              defaultValue={data.year}
              onChange={(event) => router.push(`/dashboard/wrapped?year=${event.target.value}`)}
              onFocus={() => setPaused(true)}
              className="min-h-11 cursor-pointer appearance-none border-0 bg-transparent pl-2 pr-5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
            >
              {years.map((year) => (
                <option key={year} value={year} className="bg-background">
                  {year}
                </option>
              ))}
            </select>
            <ChevronDown
              aria-hidden="true"
              size={12}
              className="pointer-events-none absolute right-0 text-muted-foreground"
            />
            <noscript>
              <button type="submit" className={buttonClass}>
                View
              </button>
            </noscript>
          </form>
          {hasActivity && slide < TITLES.length - 1 && (
            <button
              type="button"
              className={cn(buttonClass, 'bg-transparent text-muted-foreground hover:bg-secondary')}
              onClick={() => setPaused((value) => !value)}
              aria-label={paused ? 'Play story' : 'Pause story'}
            >
              {paused ? <Play size={16} /> : <Pause size={16} />}
            </button>
          )}
          <Link
            ref={close}
            href="/dashboard#wrapped-entry"
            className={buttonClass}
            aria-label="Close Wrapped"
          >
            <X size={18} />
          </Link>
        </header>
        <p className="sr-only">
          {data.yearToDate ? 'YEAR TO DATE' : 'CALENDAR YEAR'} · ALL PROJECTS · UTC
        </p>

        {!hasActivity ? (
          <div className="flex min-h-0 flex-1 flex-col justify-center gap-6 overflow-y-auto py-12">
            <ShieldCheck size={32} className="text-primary" />
            <h1
              ref={focusHeading}
              tabIndex={-1}
              className="text-4xl font-semibold tracking-tight outline-none"
            >
              Your year is
              <br />
              just getting started.
            </h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              No saved memories, sessions or judgments in {data.year} yet. Choose another year, or
              come back after your next session.
            </p>
            <Link
              href="/dashboard#wrapped-entry"
              className={cn(
                buttonClass,
                'bg-primary px-5 font-semibold text-primary-foreground hover:bg-primary/90',
              )}
            >
              Back to dashboard <ArrowRight className="ml-2" size={18} />
            </Link>
          </div>
        ) : (
          <>
            <p id="wrapped-navigation-help" className="sr-only">
              Tap the left or right side to move between screens. Hold to pause. Use arrow keys,
              Home or End to navigate and Space to pause or play.
            </p>
            <div
              className="wrapped-content"
              role="presentation"
              onClick={navigateTap}
              onPointerDown={(event) => {
                pointerStart.current = {
                  x: event.clientX,
                  y: event.clientY,
                  at: performance.now(),
                };
                setHeld(true);
              }}
              onPointerUp={() => setHeld(false)}
              onPointerCancel={() => {
                pointerStart.current = null;
                setHeld(false);
              }}
            >
              <AnimatePresence mode="wait" initial={false}>
                <motion.section
                  key={slide}
                  initial={reduce ? false : { opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduce ? { opacity: 1 } : { opacity: 0, y: -8 }}
                  transition={{ duration: reduce ? 0 : 0.2 }}
                  aria-labelledby="wrapped-heading"
                  className={cn(
                    'flex min-w-0 flex-col gap-5',
                    slide === 0 && 'wrapped-intro',
                    slide > 0 && 'wrapped-slide',
                    slide === 2 && 'wrapped-agents-slide',
                    slide === 3 && 'wrapped-types-slide',
                    slide === 4 && 'wrapped-judgments-slide',
                    slide === 5 && 'wrapped-entities-slide',
                    slide === 6 && 'wrapped-projects-slide',
                    slide === 7 && 'wrapped-rhythm-slide',
                    slide === 8 && 'wrapped-months-slide',
                    slide === 9 && 'wrapped-share-slide',
                  )}
                >
                  <h1
                    id="wrapped-heading"
                    aria-describedby="wrapped-navigation-help"
                    ref={focusHeading}
                    tabIndex={-1}
                    className={cn(
                      'outline-none font-semibold tracking-tight',
                      slide === 0 ? 'text-[52px] leading-[1.02]' : 'text-[38px] leading-[1.05]',
                    )}
                  >
                    {slide === 0 ? (
                      <>
                        Your year.
                        <br />
                        In memory.
                      </>
                    ) : (
                      TITLES[slide]
                    )}
                  </h1>
                  {slide === 0 && (
                    <>
                      <div className="wrapped-cover">
                        <div className="wrapped-cover-back" aria-hidden="true">
                          <span>Memory. In motion.</span>
                          <div className="wrapped-cover-code">
                            <span />
                            <span />
                            <span />
                            <span />
                          </div>
                        </div>
                        <div className="wrapped-cover-front">
                          <Image
                            src="/dashboard/assets/logo-transparent.png"
                            alt=""
                            width={48}
                            height={48}
                          />
                          <div className="wrapped-edition">
                            <span>Wrapped</span>
                            <NumberTicker
                              value={data.year}
                              startOnView={false}
                              className="wrapped-year-number font-semibold leading-none tracking-[-.08em]"
                            />
                          </div>
                          <div className="wrapped-cover-caption">
                            <span>
                              Your year.
                              <br />
                              Kept with you.
                            </span>
                            <ArrowRight size={24} aria-hidden="true" />
                          </div>
                        </div>
                      </div>
                      <div className="wrapped-intro-totals grid grid-cols-3 gap-3">
                        <Metric value={data.memories} label="memories" />
                        <Metric value={data.sessions} label="sessions" />
                        <Metric value={data.judgments} label="judgments" />
                        <Metric value={data.projects} label="active projects" />
                        <Metric value={data.activeDays} label="days active" />
                        <Metric value={data.longestStreak} label="day streak" />
                      </div>
                    </>
                  )}
                  {slide === 1 && (
                    <>
                      <div className="wrapped-memory-stack">
                        <div className="wrapped-stack-edge" aria-hidden="true" />
                        <div className="wrapped-memory-main">
                          <span className="wrapped-card-label">
                            Saved with Rembric <span aria-hidden="true">↗</span>
                          </span>
                          <BigNumber value={data.memories} label="memories saved" />
                          <span className="wrapped-memory-rule" aria-hidden="true" />
                        </div>
                        <div className="wrapped-memory-bottom">
                          <Metric value={data.sessions} label="sessions" />
                          <Metric value={data.judgments} label="judgments" />
                          <Metric value={data.projects} label="active projects" />
                        </div>
                      </div>
                      <p className="sr-only">
                        Saves include active, archived and superseded memories. Sessions exclude
                        deleted records. Judgments count retained decisions by their judgment date,
                        excluding pending and orphaned candidates.
                      </p>
                    </>
                  )}
                  {slide === 2 && (
                    <>
                      {data.agents.length > 0 ? (
                        <>
                          <div className="wrapped-agent-pass">
                            <div className="wrapped-card-label">
                              <span>Most sessions</span>
                              <span aria-hidden="true">↗</span>
                            </div>
                            <span className="wrapped-agent-mark" aria-hidden="true">
                              &gt;_
                            </span>
                            <p className="wrapped-agent-name">{data.agents[0]!.agent}</p>
                            <Metric value={data.agents[0]!.n} label="sessions together" />
                          </div>
                          {data.agents.length > 1 && (
                            <BarList
                              rows={data.agents
                                .slice(1)
                                .map((row) => ({ label: row.agent, n: row.n }))}
                            />
                          )}
                        </>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          No sessions recorded this year. Your saves still count.
                        </p>
                      )}
                      <p className="sr-only">
                        By session starts. Custom agents are grouped as Other.
                      </p>
                    </>
                  )}
                  {slide === 3 && (
                    <>
                      <p className="sr-only">Fixed memory categories, never private content.</p>
                      {types.length > 0 ? (
                        <>
                          <div className="wrapped-type-deck">
                            {types.map(([type, n]) => (
                              <div key={type} className="wrapped-type-file">
                                <div className="wrapped-file-tab" aria-hidden="true" />
                                <span className="wrapped-type-name">{TYPE_LABELS[type]}</span>
                                <Metric value={n} label={n === 1 ? 'memory' : 'memories'} />
                              </div>
                            ))}
                          </div>
                        </>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          No memory saves this year yet.
                        </p>
                      )}
                    </>
                  )}
                  {slide === 4 && (
                    <>
                      <div className="wrapped-judgments-card">
                        <div className="wrapped-decision-mark" aria-hidden="true">
                          <span />↔<span />
                        </div>
                        <BigNumber value={data.judgments} label="judgments made" lime />
                      </div>
                      {data.judgments > 0 ? (
                        <BarList
                          rows={(Object.keys(JUDGMENT_LABELS) as RelationKind[])
                            .filter((kind) => data.judgmentTypes[kind] > 0)
                            .map((kind) => ({
                              label: JUDGMENT_LABELS[kind],
                              n: data.judgmentTypes[kind],
                            }))
                            .sort((a, b) => b.n - a.n)}
                        />
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          No judgments recorded this year. Connections will appear as your memories
                          are compared.
                        </p>
                      )}
                      <p className="sr-only">
                        Retained decisions by judgment date, not pending candidates. Repeated
                        decisions on the same relation count once.
                      </p>
                    </>
                  )}
                  {slide === 5 && <EntityScene data={data} />}
                  {slide === 6 && <ProjectScene data={data} />}
                  {slide === 7 && (
                    <>
                      <div className="wrapped-hero">
                        <BigNumber value={data.activeDays} label="days active" lime />
                      </div>
                      <div className="wrapped-calendar-sheet">
                        <div className="wrapped-card-label">
                          <span>{data.year}</span>
                          <span>Every day counts</span>
                        </div>
                        <ActivityGrid data={data} />
                        <div className="wrapped-streak">
                          <Metric value={data.longestStreak} label="longest day streak" />
                          <span className="wrapped-streak-line" aria-hidden="true" />
                        </div>
                      </div>
                      <p className="sr-only">
                        An active UTC day includes a memory save, a session start or a judgment.
                        Multiple events count as one day.
                      </p>
                    </>
                  )}
                  {slide === 8 && (
                    <>
                      <div className="wrapped-month-poster">
                        {peak > 0 ? (
                          <div className="wrapped-peak">
                            <span className="wrapped-month-watermark" aria-hidden="true">
                              {String(peakMonth + 1).padStart(2, '0')}
                            </span>
                            <span className="font-mono text-xs text-muted-foreground">
                              Peak month
                            </span>
                            <p>{WRAPPED_MONTHS[peakMonth]}</p>
                            <Metric value={peak} label="memories saved" />
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground">
                            No saves this year yet. Session activity appears on the rhythm screen.
                          </p>
                        )}
                        <MonthlyBars data={data} />
                      </div>
                      <div className="sr-only">
                        {data.months.map((n, i) => (
                          <div key={i} className="rounded-lg bg-card px-2 py-2">
                            {WRAPPED_MONTHS[i]!.slice(0, 3)}{' '}
                            <NumberTicker value={n} locale className="ml-1 text-foreground" />
                          </div>
                        ))}
                      </div>
                      <p className="sr-only">
                        Memory saves by month. Equal peaks use the earliest month.
                      </p>
                    </>
                  )}
                  {slide === 9 && (
                    <>
                      <ShareImage data={data} />
                    </>
                  )}
                </motion.section>
              </AnimatePresence>
            </div>
            <nav
              className="pointer-events-none absolute inset-x-6 bottom-6 z-10 flex justify-between"
              aria-label="Story navigation"
            >
              <button
                type="button"
                className={cn(
                  buttonClass,
                  'sr-only min-h-0 min-w-0 focus-visible:not-sr-only focus-visible:pointer-events-auto focus-visible:min-h-11 focus-visible:min-w-11 focus-visible:px-4',
                )}
                disabled={slide === 0}
                onClick={() => {
                  setPaused(true);
                  setSlide((current) => Math.max(0, current - 1));
                }}
              >
                Previous screen
              </button>
              <button
                type="button"
                className={cn(
                  buttonClass,
                  'sr-only min-h-0 min-w-0 focus-visible:not-sr-only focus-visible:pointer-events-auto focus-visible:min-h-11 focus-visible:min-w-11 focus-visible:px-4',
                )}
                disabled={slide === TITLES.length - 1}
                onClick={() => {
                  setPaused(true);
                  setSlide((current) => Math.min(TITLES.length - 1, current + 1));
                }}
              >
                Next screen
              </button>
            </nav>
          </>
        )}
        <p className="sr-only">Based on retained records in this instance.</p>
      </article>
    </main>
  );
}

function EntityScene({ data }: { data: WrappedStats }) {
  const rows = wrappedEntityMemoryRows(data.entities.memoryKinds);
  const partial = data.entities.scannedMemories < data.entities.eligibleMemories;
  return (
    <>
      {rows.length > 0 ? (
        <>
          <div className="wrapped-agent-pass">
            <div className="wrapped-card-label">
              <span>Most memories</span>
              <span aria-hidden="true">↗</span>
            </div>
            <span className="wrapped-agent-mark" aria-hidden="true">
              {'{ }'}
            </span>
            <p className="wrapped-agent-name">{rows[0]!.label}</p>
            <Metric value={rows[0]!.n} label="memories with this type" />
          </div>
          {rows.length > 1 && <BarList rows={rows.slice(1)} unit="memories" />}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          No indexed entities linked to this year’s memories yet.
        </p>
      )}
      <div className="wrapped-entity-totals">
        <Metric value={data.entities.total} label="entities in total" />
        <Metric value={data.entities.recurring} label="in multiple memories" />
      </div>
      {partial && (
        <p className="wrapped-index-note">
          Partial index · {data.entities.scannedMemories.toLocaleString('en-US')} /{' '}
          {data.entities.eligibleMemories.toLocaleString('en-US')} project memories scanned
        </p>
      )}
      <p className="sr-only">
        Distinct kind and value pairs across projects, linked to retained memories saved this year.
        Each type counts distinct memories; a memory with multiple types counts in each. Scanning
        does not guarantee successful extraction.
      </p>
    </>
  );
}

function ProjectScene({ data }: { data: WrappedStats }) {
  const rows = data.projectMemories.top.map(({ name, n }) => ({ label: name, n }));
  if (data.projectMemories.other > 0) rows.push({ label: 'Other', n: data.projectMemories.other });
  const total = rows.reduce((sum, row) => sum + row.n, 0);
  return (
    <>
      <div className="wrapped-project-count">
        <Metric value={data.projects} label="active projects" />
      </div>
      {total > 0 ? (
        <>
          <ul className="wrapped-type-deck wrapped-project-deck">
            {rows.map((row, rank) => (
              <li key={rank} className="wrapped-type-file">
                <div className="wrapped-file-tab" aria-hidden="true" />
                <span className="wrapped-type-name line-clamp-2" title={row.label}>
                  {row.label}
                </span>
                <Metric value={row.n} label={row.n === 1 ? 'memory' : 'memories'} />
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">
            Your leading project held{' '}
            <strong className="text-foreground">
              {((rows[0]!.n / total) * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%
            </strong>{' '}
            of your project-linked memories.
          </p>
          <p className="sr-only">
            Projects ranked by memory saves. Global memories are excluded from this distribution.
            Projects with sessions but no saves still count as active.
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          No project-linked memories saved this year. Projects with sessions still count as active.
        </p>
      )}
    </>
  );
}

function BigNumber({ value, label, lime }: { value: number; label: string; lime?: boolean }) {
  return (
    <div
      className="wrapped-figure min-w-0"
      title={value.toLocaleString('en-US')}
      style={{ '--wrapped-digits': formatWrappedCount(value).length } as CSSProperties}
    >
      <NumberTicker
        value={value}
        format={formatWrappedCount}
        ariaLabel={value.toLocaleString('en-US')}
        startOnView={false}
        className={cn(
          'wrapped-number font-semibold leading-none tracking-[-.06em]',
          lime && 'text-primary',
        )}
      />
      <p className="mt-3 text-sm text-muted-foreground">{label}</p>
    </div>
  );
}
function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div
      className="wrapped-figure min-w-0"
      title={value.toLocaleString('en-US')}
      style={{ '--wrapped-digits': formatWrappedCount(value).length } as CSSProperties}
    >
      <NumberTicker
        value={value}
        format={formatWrappedCount}
        ariaLabel={value.toLocaleString('en-US')}
        startOnView={false}
        className="wrapped-metric font-semibold tracking-tight"
      />
      <p className="mt-2 text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
function BarList({ rows, unit }: { rows: { label: string; n: number }[]; unit?: string }) {
  const reduce = useReducedMotion();
  const max = Math.max(1, ...rows.map((row) => row.n));
  return (
    <ul className="wrapped-bars flex flex-col">
      {rows.map((row, i) => (
        <li key={row.label} className="wrapped-bar-row">
          <div className="relative z-10 flex items-center justify-between gap-3 text-sm">
            <span>{row.label}</span>
            <span
              className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground"
              title={row.n.toLocaleString('en-US')}
            >
              <NumberTicker
                value={row.n}
                format={formatWrappedCount}
                ariaLabel={row.n.toLocaleString('en-US')}
              />
              {unit && ` ${unit}`}
            </span>
          </div>
          <div className="wrapped-bar-track" aria-hidden="true">
            <motion.div
              className={cn('h-full rounded-r-lg', i === 0 ? 'bg-primary' : 'bg-chart-2')}
              initial={reduce ? false : { width: 0 }}
              animate={{ width: `${(row.n / max) * 100}%` }}
              transition={{ duration: reduce ? 0 : 0.45, delay: reduce ? 0 : i * 0.04 }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
function MonthlyBars({ data }: { data: WrappedStats }) {
  const reduce = useReducedMotion();
  const max = Math.max(1, ...data.months);
  return (
    <div className="wrapped-monthly">
      <div className="wrapped-monthly-plot flex items-end gap-2" aria-label="Monthly memory saves">
        {data.months.map((n, i) => (
          <motion.div
            key={i}
            className={cn(
              'min-w-0 flex-1 rounded-t',
              n > 0 && n === max ? 'bg-primary' : 'bg-chart-3',
            )}
            title={`${WRAPPED_MONTHS[i]}: ${n.toLocaleString('en-US')} saves`}
            role="img"
            aria-label={`${WRAPPED_MONTHS[i]}: ${n.toLocaleString('en-US')} saves`}
            initial={reduce ? false : { height: 3 }}
            animate={{ height: `${Math.max(3, (n / max) * 100)}%` }}
            transition={{ duration: reduce ? 0 : 0.4, delay: reduce ? 0 : i * 0.025 }}
          />
        ))}
      </div>
      <div className="mt-2 flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>Jan</span>
        <span>Jun</span>
        <span>Dec</span>
      </div>
    </div>
  );
}
function ActivityGrid({ data }: { data: WrappedStats }) {
  const counts = new Map(data.days.map((row) => [row.day, row.n]));
  const max = Math.max(1, ...data.days.map((row) => row.n));
  return (
    <div
      className="wrapped-calendar"
      role="img"
      aria-label={`${data.activeDays} active UTC days across ${data.year}`}
    >
      {WRAPPED_MONTHS.map((month, m) => {
        const first = new Date(Date.UTC(data.year, m, 1));
        const days = new Date(Date.UTC(data.year, m + 1, 0)).getUTCDate();
        return (
          <div key={month}>
            <p className="mb-2 font-mono text-[10px] text-muted-foreground">{month.slice(0, 3)}</p>
            <div className="wrapped-calendar-month" aria-hidden="true">
              {Array.from({ length: days }, (_, i) => {
                const n = counts.get(first.getTime() / DAY_MS + i) ?? 0;
                return (
                  <span
                    key={i}
                    className={n > 0 ? 'bg-primary' : 'bg-chart-4'}
                    style={{
                      gridColumnStart: i === 0 ? first.getUTCDay() + 1 : undefined,
                      opacity: n > 0 ? 0.35 + (0.65 * n) / max : 0.45,
                    }}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
function ShareImage({ data }: { data: WrappedStats }) {
  const [format, setFormat] = useState<WrappedImageFormat>('square');
  const [image, setImage] = useState<{
    url: string;
    format: WrappedImageFormat;
    file: File;
  } | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let url: string | undefined;
    setImage(null);
    setError(null);
    setShareError(null);
    void createWrappedImage(data, format)
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setImage({
          url,
          format,
          file: new File([blob], `rembric-wrapped-${data.year}-${format}.png`, {
            type: 'image/png',
          }),
        });
      })
      .catch(() => {
        if (!cancelled) setError('Could not prepare the image. Please retry.');
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [data, format, retry]);
  const ready = image !== null && image.format === format;
  const nativeShare =
    ready &&
    typeof navigator.share === 'function' &&
    navigator.canShare?.({ files: [image.file] }) === true;
  async function share() {
    if (!ready || !nativeShare) return;
    setSharing(true);
    setShareError(null);
    try {
      await navigator.share({ files: [image.file], title: `Rembric Wrapped ${data.year}` });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError'))
        setShareError('Could not open sharing. Please try again.');
    } finally {
      setSharing(false);
    }
  }
  return (
    <div className="flex flex-col gap-4">
      <div
        className="wrapped-share-preview mx-auto flex min-h-64 w-full items-center justify-center p-3"
        aria-busy={!ready && !error}
      >
        {ready ? (
          <Image
            src={image.url}
            alt={`Exact export preview: ${data.memories} memories, ${data.sessions} sessions, ${data.judgments} judgments, ${data.projects} active projects, ${data.entities.total} indexed entities, ${data.activeDays} active days, ${data.longestStreak} day streak${data.entities.scannedMemories < data.entities.eligibleMemories ? ', partial entity index' : ''}`}
            width={WRAPPED_IMAGE_SIZES[format].width}
            height={WRAPPED_IMAGE_SIZES[format].height}
            unoptimized
            className={cn(
              'h-auto w-auto max-h-[340px] rounded-xl',
              format === 'story' && 'max-h-[390px]',
            )}
          />
        ) : (
          <p
            role={error ? 'alert' : 'status'}
            className="p-6 text-center text-sm text-muted-foreground"
          >
            {error ?? 'Preparing your image…'}
          </p>
        )}
      </div>
      <fieldset className="grid grid-cols-2 gap-3">
        <legend className="sr-only">Image format</legend>
        {(['square', 'story'] as const).map((value) => (
          <label
            key={value}
            className={cn(
              buttonClass,
              'cursor-pointer border px-3 text-xs has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-primary',
              format === value ? 'border-primary' : 'border-border',
            )}
          >
            <input
              type="radio"
              name="wrapped-format"
              value={value}
              checked={format === value}
              onChange={() => setFormat(value)}
              className="sr-only"
            />
            {value === 'square' ? 'Square · 1:1' : 'Story · 9:16'}
          </label>
        ))}
      </fieldset>
      {ready ? (
        <>
          <button
            type="button"
            disabled={!nativeShare || sharing}
            onClick={() => {
              void share();
            }}
            className={cn(
              buttonClass,
              'gap-2 bg-primary px-4 font-semibold text-primary-foreground hover:bg-primary/90',
            )}
          >
            <Share2 size={18} />
            {sharing ? 'Opening sharing…' : 'Share Wrapped'}
          </button>
          {shareError && (
            <p role="alert" className="text-sm text-muted-foreground">
              {shareError}
            </p>
          )}
          {!nativeShare && (
            <p role="status" className="text-center text-xs text-muted-foreground">
              This browser cannot share images natively.{' '}
              <a
                href={image.url}
                download={image.file.name}
                className="inline-flex min-h-11 items-center text-foreground underline"
              >
                Save the card
              </a>{' '}
              to share it from your social app.
            </p>
          )}
        </>
      ) : (
        <button
          type="button"
          disabled={!error}
          onClick={() => setRetry((n) => n + 1)}
          className={cn(
            buttonClass,
            'gap-2 bg-primary px-4 font-semibold text-primary-foreground hover:bg-primary/90',
          )}
        >
          {error ? 'Retry image' : 'Preparing image…'}
        </button>
      )}
      <p className="text-center font-mono text-[10px] text-muted-foreground">
        {WRAPPED_IMAGE_SIZES[format].width} × {WRAPPED_IMAGE_SIZES[format].height} PNG · This
        preview is the image you share.
      </p>
    </div>
  );
}
