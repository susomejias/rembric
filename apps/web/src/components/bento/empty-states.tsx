'use client';

import { motion, useInView, useReducedMotion, type Variants } from 'motion/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';

import { cn } from '@/lib/utils';

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

const SPRING_ENTRANCE: { type: 'spring'; stiffness: number; damping: number } = {
  type: 'spring',
  stiffness: 260,
  damping: 20,
};
const SPRING_FLUID: { type: 'spring'; stiffness: number; damping: number } = {
  type: 'spring',
  stiffness: 300,
  damping: 30,
};
const SPRING_SNAPPY: { type: 'spring'; stiffness: number; damping: number } = {
  type: 'spring',
  stiffness: 500,
  damping: 28,
};

const VIEWPORT = { once: true, amount: 0.3 } as const;

const EMPTY_FONT = 'font-sans tracking-[-0.006em]';

const HAIRLINE = 'border-border';
const HAIRLINE_SOFT = 'border-border';
const INK = 'bg-accent';
const INK_SOFT = 'bg-accent';
const FADE_DOWN = '[mask-image:linear-gradient(to_bottom,black_15%,transparent_95%)]';

type Tone = 'neutral' | 'critical' | 'positive';
type BackdropKind = 'rings' | 'ripple' | 'scan' | 'comet' | 'sieve';

type GlyphProps = React.SVGProps<SVGSVGElement>;

function Glyph({ children, ...props }: GlyphProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

function IconSearch(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Glyph>
  );
}

function IconFilter(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M4 5h16l-6.2 7.3V19L10 17v-4.7Z" />
    </Glyph>
  );
}

function IconDocument(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
    </Glyph>
  );
}

function IconDiscovery(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2 5-5 2 2-5Z" />
    </Glyph>
  );
}

function IconCloseSquare(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <path d="m9.5 9.5 5 5m0-5-5 5" />
    </Glyph>
  );
}

function IconTickSquare(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <path d="m8.5 12.2 2.4 2.4 4.6-5" />
    </Glyph>
  );
}

function IconCopy(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="9" y="9" width="10" height="10" rx="2.5" />
      <path d="M6 15H5.5A1.5 1.5 0 0 1 4 13.5v-8A1.5 1.5 0 0 1 5.5 4h8A1.5 1.5 0 0 1 15 5.5V6" />
    </Glyph>
  );
}

function Backdrop({
  kind,
  phase,
  reduced,
}: {
  kind: BackdropKind;
  phase: boolean;
  reduced: boolean;
}) {
  switch (kind) {
    case 'rings':
      return (
        <>
          {[112, 164].map((diameter, index) => (
            <motion.span
              key={diameter}
              initial="hidden"
              animate={phase ? 'shown' : 'hidden'}
              variants={{
                hidden: reduced ? { opacity: 0 } : { opacity: 0, scale: 0.55 },
                shown: {
                  opacity: 1,
                  scale: 1,
                  transition: reduced
                    ? { duration: 0.2 }
                    : { ...SPRING_FLUID, delay: 0.06 + index * 0.07 },
                },
              }}
              style={{ width: diameter, height: diameter }}
              className={cn(
                'absolute rounded-full border',
                index === 0 ? HAIRLINE : HAIRLINE_SOFT,
                FADE_DOWN,
              )}
            />
          ))}
        </>
      );
    case 'ripple':
      return (
        <>
          {[0, 1, 2].map((index) => (
            <motion.span
              key={index}
              initial="hidden"
              animate={phase ? 'shown' : 'hidden'}
              variants={{
                hidden: { opacity: 0, scale: 0.4 },
                shown: {
                  opacity: [0, 0.9, 0],
                  scale: [0.4, 1, 1.25],
                  transition: reduced
                    ? { duration: 0 }
                    : { duration: 1.5, delay: index * 0.22, ease: EASE_OUT },
                },
              }}
              className={cn('absolute size-[150px] rounded-full border', HAIRLINE)}
            />
          ))}
          <span className={cn('absolute size-[92px] rounded-full border', HAIRLINE_SOFT)} />
        </>
      );
    case 'scan':
      return (
        <div
          className={cn(
            'absolute size-[150px] overflow-hidden rounded-[26px] border',
            HAIRLINE,
            FADE_DOWN,
          )}
        >
          <motion.span
            initial="hidden"
            animate={phase ? 'shown' : 'hidden'}
            variants={{
              hidden: { y: -8, opacity: 0 },
              shown: {
                y: 150,
                opacity: [0, 1, 1, 0],
                transition: reduced ? { duration: 0 } : { duration: 1.1, ease: EASE_OUT },
              },
            }}
            className="absolute inset-x-0 h-px bg-destructive/10"
          />
        </div>
      );
    case 'comet':
      return (
        <>
          <span
            className={cn('absolute size-[136px] rounded-full border', HAIRLINE_SOFT, FADE_DOWN)}
          />
          <motion.span
            initial="hidden"
            animate={phase ? 'shown' : 'hidden'}
            variants={{
              hidden: { rotate: -40, opacity: 0 },
              shown: {
                rotate: 320,
                opacity: [0, 1, 1, 0],
                transition: reduced ? { duration: 0 } : { duration: 1.6, ease: EASE_OUT },
              },
            }}
            className="absolute size-[136px]"
          >
            <span
              className="absolute top-0 left-1/2 h-[7px] w-[34px] -translate-x-full rounded-full"
              style={{
                background:
                  'linear-gradient(to right, transparent, color-mix(in oklab, currentColor 18%, transparent))',
              }}
            />
            <span
              className={cn(
                'absolute top-0 left-1/2 size-[6px] -translate-x-1/2 rounded-full',
                INK,
              )}
            />
          </motion.span>
        </>
      );
    case 'sieve':
      return (
        <div className="absolute bottom-[calc(100%+2px)] flex flex-col items-center gap-2">
          {[9, 6, 3].map((count, row) => (
            <div key={count} className="flex gap-2">
              {Array.from({ length: count }).map((_, index) => (
                <motion.span
                  key={index}
                  initial="hidden"
                  animate={phase ? 'shown' : 'hidden'}
                  variants={{
                    hidden: reduced ? { opacity: 0 } : { opacity: 0, y: -5, scale: 0.6 },
                    shown: {
                      opacity: 1,
                      y: 0,
                      scale: 1,
                      transition: reduced
                        ? { duration: 0.2 }
                        : {
                            ...SPRING_SNAPPY,
                            delay: 0.05 + row * 0.08 + Math.abs(index - (count - 1) / 2) * 0.02,
                          },
                    },
                  }}
                  className={cn('size-[3px] rounded-full', row === 2 ? INK : INK_SOFT)}
                />
              ))}
            </div>
          ))}
        </div>
      );
  }
}

function Medallion({
  icon,
  tone = 'neutral',
  size = 'md',
  backdrop = 'rings',
}: {
  icon: React.ReactNode;
  tone?: Tone;
  size?: 'sm' | 'md' | 'lg';
  backdrop?: BackdropKind;
}) {
  const reduced = useReducedMotion();
  const ref = React.useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true, amount: 0.4 });

  const tile = {
    sm: 'size-10 rounded-xl [&_svg]:size-[18px]',
    md: 'size-14 rounded-2xl [&_svg]:size-6',
    lg: 'size-16 rounded-3xl [&_svg]:size-7',
  }[size];

  const glyph = {
    neutral: 'text-primary',
    critical: 'text-destructive',
    positive: 'text-primary',
  }[tone];

  return (
    <div ref={ref} className="relative grid place-items-center">
      <div aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center">
        <Backdrop kind={backdrop} phase={seen} reduced={Boolean(reduced)} />
      </div>

      <motion.div
        initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.84, filter: 'blur(6px)' }}
        whileInView={reduced ? { opacity: 1 } : { opacity: 1, scale: 1, filter: 'blur(0px)' }}
        viewport={VIEWPORT}
        transition={reduced ? { duration: 0.15 } : SPRING_ENTRANCE}
        className={cn(
          'relative grid place-items-center border border-border bg-muted',
          'shadow-sm',
          tile,
          glyph,
        )}
      >
        {icon}
      </motion.div>
    </div>
  );
}

function useReveal() {
  const reduced = useReducedMotion();

  return React.useMemo(() => {
    const stack: Variants = {
      hidden: {},
      shown: {
        transition: {
          staggerChildren: reduced ? 0 : 0.055,
          delayChildren: reduced ? 0 : 0.04,
        },
      },
    };

    const item: Variants = reduced
      ? { hidden: { opacity: 0 }, shown: { opacity: 1, transition: { duration: 0.15 } } }
      : { hidden: { opacity: 0, y: 8 }, shown: { opacity: 1, y: 0, transition: SPRING_ENTRANCE } };

    return { stack, item, reduced };
  }, [reduced]);
}

function EmptyState({
  icon,
  tone = 'neutral',
  backdrop = 'rings',
  medallionSize = 'md',
  eyebrow,
  title,
  description,
  children,
  actions,
  footnote,
}: {
  icon?: React.ReactNode;
  tone?: Tone;
  backdrop?: BackdropKind;
  medallionSize?: 'sm' | 'md' | 'lg';
  eyebrow?: string;
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  footnote?: React.ReactNode;
}) {
  const { stack, item } = useReveal();

  return (
    <motion.div
      variants={stack}
      initial="hidden"
      whileInView="shown"
      viewport={VIEWPORT}
      className={cn(EMPTY_FONT, 'flex w-full flex-col items-center text-center')}
    >
      {icon && (
        <motion.div variants={item} className="mb-5">
          <Medallion icon={icon} tone={tone} size={medallionSize} backdrop={backdrop} />
        </motion.div>
      )}

      {eyebrow && (
        <motion.p
          variants={item}
          className="mb-2 font-mono text-[12px] font-medium tracking-[0.12em] text-muted-foreground uppercase"
        >
          {eyebrow}
        </motion.p>
      )}

      <motion.h3
        variants={item}
        className="text-balance text-[17px] font-semibold tracking-[-0.014em] text-foreground"
      >
        {title}
      </motion.h3>

      {description && (
        <motion.p
          variants={item}
          className="mt-2.5 max-w-[46ch] text-pretty text-[13.5px] leading-[1.62] text-muted-foreground"
        >
          {description}
        </motion.p>
      )}

      {children && (
        <motion.div variants={item} className="mt-5 flex w-full justify-center">
          {children}
        </motion.div>
      )}

      {actions && (
        <motion.div
          variants={item}
          className="mt-6 flex flex-wrap items-center justify-center gap-2"
        >
          {actions}
        </motion.div>
      )}

      {footnote && (
        <motion.div
          variants={item}
          className="mt-5 text-[13px] leading-[1.55] text-muted-foreground"
        >
          {footnote}
        </motion.div>
      )}
    </motion.div>
  );
}

const EMPHASIS = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary/10 hover:text-primary-foreground',
  secondary: 'border border-border bg-accent text-foreground hover:bg-accent hover:text-foreground',
  quiet: 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
} as const;

type ActionProps = {
  emphasis?: keyof typeof EMPHASIS;
  icon?: React.ReactNode;
  trailing?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
} & Omit<
  React.ComponentProps<'button'>,
  | 'children'
  | 'className'
  | 'onDrag'
  | 'onDragStart'
  | 'onDragEnd'
  | 'onDragEnter'
  | 'onDragExit'
  | 'onDragLeave'
  | 'onDragOver'
  | 'onDrop'
  | 'onAnimationStart'
  | 'onAnimationEnd'
  | 'onAnimationIteration'
>;

function actionClass(emphasis: keyof typeof EMPHASIS, className?: string) {
  return cn(
    'inline-flex h-9 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-xl px-3.5',
    'text-[14px] font-medium whitespace-nowrap transition-colors duration-150 outline-none select-none',
    'focus-visible:ring-1 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50',
    '[&_svg]:size-[15px]',
    EMPHASIS[emphasis],
    className,
  );
}

const MotionLink = motion.create(Link);

function EmptyAction({ emphasis = 'primary', className, children, ...props }: ActionProps) {
  const reduced = useReducedMotion();

  return (
    <motion.button
      type="button"
      whileTap={reduced ? undefined : { scale: 0.96 }}
      transition={SPRING_SNAPPY}
      className={actionClass(emphasis, className)}
      {...props}
    >
      {children}
    </motion.button>
  );
}

function EmptyActionLink({
  emphasis = 'primary',
  href,
  className,
  children,
  onNavigate,
}: {
  emphasis?: keyof typeof EMPHASIS;
  href: string;
  className?: string;
  children: React.ReactNode;
  onNavigate?: () => void;
}) {
  const reduced = useReducedMotion();

  return (
    <MotionLink
      href={href}
      prefetch={false}
      onClick={onNavigate}
      whileTap={reduced ? undefined : { scale: 0.96 }}
      transition={SPRING_SNAPPY}
      className={actionClass(emphasis, className)}
    >
      {children}
    </MotionLink>
  );
}

function GhostRows({ rows = 4, fade = 'down' }: { rows?: number; fade?: 'down' | 'up' }) {
  const reduced = useReducedMotion();

  return (
    <div aria-hidden className="flex w-full flex-col gap-2">
      {Array.from({ length: rows }).map((_, index) => {
        const depth = fade === 'down' ? index : rows - 1 - index;
        return (
          <motion.div
            key={index}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
            whileInView={{ opacity: Math.max(0.08, 0.5 - depth * 0.11), y: 0 }}
            viewport={VIEWPORT}
            transition={reduced ? { duration: 0.2 } : { ...SPRING_FLUID, delay: 0.05 * index }}
            className="flex items-center gap-3 rounded-xl border border-border px-3 py-2.5"
          >
            <span className="size-6 shrink-0 rounded-full bg-accent" />
            <span className="h-2 flex-1 rounded-full bg-accent" />
            <span className="h-2 w-10 rounded-full bg-accent" />
          </motion.div>
        );
      })}
    </div>
  );
}

const PANEL = 'w-full overflow-hidden rounded-2xl border border-border bg-card';

export interface EmptyTableColumn {
  id: string;
  label: string;
  align?: 'left' | 'right';
  width?: string;
}

export interface Destination {
  label: string;
  href: string;
  section?: string;
}

export function TableNoResults({
  filters = [],
  total,
  clearHref,
  clearLabel = 'CLEAR FILTERS',
  title = 'No rows match these filters',
  description = 'Drop a filter and see what comes back, or clear the whole set.',
  className,
}: {
  filters?: { id: string; label: string; value: string; href: string }[];
  total?: number;
  clearHref: string;
  clearLabel?: string;
  title?: string;
  description?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn(EMPTY_FONT, 'flex flex-col items-center px-5 py-10 md:px-6', className)}>
      <EmptyState
        icon={<IconFilter />}
        backdrop="sieve"
        title={title}
        description={description}
        actions={
          <>
            <EmptyActionLink href={clearHref}>{clearLabel}</EmptyActionLink>
            {total !== undefined ? (
              <span className="font-mono text-[12.5px] text-muted-foreground tabular-nums">
                {total.toLocaleString('en-US')} rows in the unfiltered list
              </span>
            ) : null}
          </>
        }
      >
        {filters.length > 0 && (
          <div className="flex w-full max-w-[520px] flex-col items-center gap-3">
            <div className="flex flex-wrap items-center justify-center gap-1.5">
              {filters.map((filter) => (
                <a
                  key={filter.id}
                  href={filter.href}
                  className={cn(
                    'group/chip inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1',
                    'font-mono text-[12.5px] text-muted-foreground transition-colors duration-150',
                    'hover:border-primary/30 hover:text-foreground',
                    'focus-visible:ring-1 focus-visible:ring-primary focus-visible:outline-hidden',
                  )}
                >
                  <span className="text-muted-foreground">{filter.label}</span>
                  <span>{filter.value}</span>
                  <span className="text-muted-foreground transition-colors group-hover/chip:text-destructive">
                    ×
                  </span>
                </a>
              ))}
            </div>
            <GhostRows rows={3} fade="up" />
          </div>
        )}
      </EmptyState>
    </div>
  );
}

export function TableEmptyState({
  title,
  description,
  columns = [],
  hint,
  action,
  className,
}: {
  title: string;
  description: React.ReactNode;
  columns?: EmptyTableColumn[];
  hint?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  const { stack, item } = useReveal();
  const reduced = useReducedMotion();

  return (
    <motion.div
      variants={stack}
      initial="hidden"
      whileInView="shown"
      viewport={VIEWPORT}
      className={cn(EMPTY_FONT, 'w-full', className)}
    >
      {columns.length > 0 && (
        <motion.div
          variants={item}
          className="grid w-full gap-3 border-b border-border px-5 py-2.5 md:px-6"
          style={{ gridTemplateColumns: gridFor(columns) }}
        >
          {columns.map((column) => (
            <span
              key={column.id}
              className={cn(
                'text-[10px] tracking-[.14em] text-muted-foreground uppercase',
                column.align === 'right' && 'text-right',
              )}
            >
              {column.label}
            </span>
          ))}
        </motion.div>
      )}

      <div
        aria-hidden
        className="flex w-full flex-col gap-3 px-5 py-4 md:px-6"
        style={columns.length > 0 ? { gridTemplateColumns: gridFor(columns) } : undefined}
      >
        {columns.length > 0
          ? Array.from({ length: 4 }).map((_, index) => (
              <motion.div
                key={index}
                variants={item}
                className="grid gap-3"
                style={{ gridTemplateColumns: gridFor(columns) }}
              >
                {columns.map((column) => (
                  <motion.span
                    key={column.id}
                    initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
                    animate={{ opacity: Math.max(0.08, 0.3 - index * 0.05), y: 0 }}
                    transition={
                      reduced ? { duration: 0.15 } : { ...SPRING_FLUID, delay: index * 0.05 }
                    }
                    className={cn(
                      'block h-2 rounded-full bg-accent',
                      column.align === 'right' ? 'ml-auto w-10' : 'w-[70%]',
                    )}
                  />
                ))}
              </motion.div>
            ))
          : Array.from({ length: 4 }).map((_, index) => (
              <motion.span
                key={index}
                variants={item}
                className="block h-2 w-[70%] rounded-full bg-accent"
              />
            ))}
      </div>

      <motion.div variants={item} className="border-t border-border">
        <EmptyState
          icon={<IconDocument />}
          medallionSize="sm"
          backdrop="rings"
          title={title}
          description={description}
          actions={
            <>
              {action}
              {hint ? (
                <span className="max-w-[46ch] text-left text-[12.5px] leading-[1.5] text-muted-foreground">
                  {hint}
                </span>
              ) : null}
            </>
          }
        />
      </motion.div>
    </motion.div>
  );
}

function gridFor(columns: EmptyTableColumn[]): string {
  return columns.map((column) => column.width ?? 'minmax(0,1fr)').join(' ');
}

export function SearchEmptyState({
  query,
  title = 'No results',
  description = 'Try a broader term, or clear the search.',
  suggestions = [],
  clearHref,
  onPick,
  className,
}: {
  query: string;
  title?: string;
  description?: React.ReactNode;
  suggestions?: string[];
  clearHref?: string;
  onPick?: (term: string) => void;
  className?: string;
}) {
  const reduced = useReducedMotion();

  return (
    <section className={cn(PANEL, EMPTY_FONT, className)}>
      <header className="flex min-w-0 items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold text-foreground">Search</p>
          <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground">
            No matches in this scope
          </p>
        </div>
        <span className="flex max-w-[220px] shrink-0 items-center gap-2 rounded-xl border border-border px-2.5 py-1.5">
          <span className="shrink-0 text-muted-foreground [&_svg]:size-[15px]">
            <IconSearch />
          </span>
          <span className="truncate font-mono text-[13px] text-muted-foreground">{query}</span>
        </span>
      </header>

      <div className="px-5 py-10 sm:px-8 sm:py-12">
        <motion.div
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={SPRING_FLUID}
        >
          <EmptyState
            icon={<IconSearch />}
            backdrop="ripple"
            title={title}
            description={
              <>
                Nothing matches <span className="font-mono text-foreground">{query}</span>.{' '}
                {description}
              </>
            }
            actions={
              <>
                {clearHref ? (
                  <EmptyActionLink emphasis="secondary" href={clearHref}>
                    Clear search
                  </EmptyActionLink>
                ) : null}
              </>
            }
          >
            {suggestions.length > 0 && (
              <div className="flex flex-wrap items-center justify-center gap-1.5">
                <span className="text-[13px] text-muted-foreground">Did you mean</span>
                {suggestions.map((suggestion) => (
                  <motion.button
                    key={suggestion}
                    type="button"
                    onClick={() => onPick?.(suggestion)}
                    whileTap={reduced ? undefined : { scale: 0.96 }}
                    transition={SPRING_SNAPPY}
                    className={cn(
                      'cursor-pointer rounded-full border border-border px-2.5 py-1 font-mono text-[12.5px] text-muted-foreground',
                      'transition-colors duration-150 hover:border-primary/30 hover:text-foreground',
                      'focus-visible:ring-1 focus-visible:ring-primary focus-visible:outline-hidden',
                    )}
                  >
                    {suggestion}
                  </motion.button>
                ))}
              </div>
            )}
          </EmptyState>
        </motion.div>
      </div>
    </section>
  );
}

export function EmptyPanel({
  title,
  meta,
  toolbar,
  children,
  className,
  bodyClassName,
}: {
  title?: React.ReactNode;
  meta?: React.ReactNode;
  toolbar?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn(PANEL, EMPTY_FONT, className)}>
      {(title || toolbar) && (
        <header className="flex min-w-0 items-center gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            {title && <p className="truncate text-[14px] font-semibold text-foreground">{title}</p>}
            {meta && (
              <p className="mt-0.5 truncate font-mono text-[12.5px] text-muted-foreground">
                {meta}
              </p>
            )}
          </div>
          {toolbar && <div className="flex shrink-0 items-center gap-1.5">{toolbar}</div>}
        </header>
      )}
      <div className={cn('px-5 py-10 sm:px-8 sm:py-12', bodyClassName)}>{children}</div>
    </section>
  );
}

export function ErrorEmpty({
  errorId,
  title = 'This did not load',
  description = 'The request failed before the view could render. Retrying is usually enough.',
  detail,
  retryLabel = 'TRY AGAIN',
  onRetry,
  className,
}: {
  errorId: string;
  title?: string;
  description?: React.ReactNode;
  detail?: string;
  retryLabel?: string;
  onRetry?: () => void;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const reduced = useReducedMotion();
  const copyTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  React.useEffect(
    () => () => {
      clearTimeout(copyTimer.current);
    },
    [],
  );

  async function copyId() {
    try {
      await navigator.clipboard.writeText(errorId);
    } catch {
      return;
    }
    setCopied(true);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1600);
  }

  return (
    <EmptyPanel
      title="Request failed"
      meta="Failed"
      className={className}
      toolbar={
        <EmptyAction emphasis="secondary" onClick={onRetry}>
          {retryLabel}
        </EmptyAction>
      }
    >
      <EmptyState
        icon={<IconCloseSquare />}
        tone="critical"
        backdrop="scan"
        title={title}
        description={description}
        footnote={
          detail ? (
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              aria-expanded={open}
              className="cursor-pointer text-[13px] text-muted-foreground underline-offset-4 transition-colors duration-150 hover:text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-primary focus-visible:outline-hidden"
            >
              {open ? 'Hide technical detail' : 'Show technical detail'}
            </button>
          ) : null
        }
      >
        <div className="w-full max-w-[440px]">
          <div className="flex min-w-0 items-center gap-2 rounded-xl border border-border bg-muted px-3 py-2">
            <span className="shrink-0 font-mono text-[12.5px] tracking-[0.07em] text-muted-foreground uppercase">
              id
            </span>
            <code className="min-w-0 flex-1 truncate text-left font-mono text-[13px] text-foreground">
              {errorId}
            </code>
            <motion.button
              type="button"
              onClick={() => void copyId()}
              aria-label="Copy the error id"
              whileTap={reduced ? undefined : { scale: 0.9 }}
              transition={SPRING_SNAPPY}
              className={cn(
                'grid size-7 shrink-0 cursor-pointer place-items-center rounded-[9px] transition-colors duration-150',
                'hover:bg-accent focus-visible:ring-1 focus-visible:ring-primary focus-visible:outline-hidden',
                copied ? 'text-primary' : 'text-muted-foreground',
                '[&_svg]:size-[15px]',
              )}
            >
              {copied ? <IconTickSquare /> : <IconCopy />}
            </motion.button>
          </div>

          {detail ? (
            <motion.div
              initial={false}
              animate={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
              transition={reduced ? { duration: 0 } : SPRING_FLUID}
              className="grid"
            >
              <div className="overflow-hidden">
                <div className="mt-2 overflow-x-auto rounded-xl border border-border bg-muted px-3 py-2 text-left">
                  <code className="font-mono text-[12.5px] leading-[1.6] whitespace-pre-wrap text-muted-foreground">
                    {detail}
                  </code>
                </div>
              </div>
            </motion.div>
          ) : null}
        </div>
      </EmptyState>
    </EmptyPanel>
  );
}

export function PageNotFound({
  destinations,
  homeHref = '/dashboard',
  homeLabel = 'OVERVIEW',
}: {
  destinations: Destination[];
  homeHref?: string;
  homeLabel?: string;
}) {
  const pathname = usePathname();
  const attempted = pathname && pathname !== '/' ? pathname : 'unknown route';
  const [term, setTerm] = React.useState('');
  const inputId = React.useId();
  const reduced = useReducedMotion();

  const needle = term.trim().toLowerCase();
  const matches = needle
    ? destinations.filter((destination) =>
        `${destination.label} ${destination.href} ${destination.section ?? ''}`
          .toLowerCase()
          .includes(needle),
      )
    : destinations;

  return (
    <EmptyPanel title="404" meta={attempted}>
      <EmptyState
        icon={<IconDiscovery />}
        backdrop="comet"
        eyebrow="404"
        title="That page is not here"
        description="The route does not exist, or the row it named is gone. Memories are append-only, so an id that used to resolve can only disappear through a purge."
        actions={<EmptyActionLink href={homeHref}>{homeLabel}</EmptyActionLink>}
        footnote={
          <span className="font-mono text-[12.5px] text-muted-foreground">
            tried <span className="text-muted-foreground">{attempted}</span>
          </span>
        }
      >
        <div className="w-full max-w-[400px]">
          <label htmlFor={inputId} className="sr-only">
            Search destinations
          </label>
          <div className="relative">
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground [&_svg]:size-4">
              <IconSearch />
            </span>
            <input
              id={inputId}
              type="search"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Search for where you were going"
              className="h-9 w-full rounded-xl border border-border bg-background pr-3 pl-9 text-[14px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/30"
            />
          </div>

          <ul className="mt-2 flex flex-col gap-0.5 text-left">
            {matches.map((destination, index) => (
              <motion.li
                key={destination.href}
                layout
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={
                  reduced ? { duration: 0.12 } : { ...SPRING_ENTRANCE, delay: 0.03 * index }
                }
              >
                <a
                  href={destination.href}
                  className="group flex items-center gap-2 rounded-xl px-2.5 py-2 transition-colors duration-150 hover:bg-primary/10 focus-visible:ring-1 focus-visible:ring-primary focus-visible:outline-hidden"
                >
                  <span className="min-w-0 flex-1 truncate text-[14px] text-muted-foreground">
                    {destination.label}
                  </span>
                  <span className="shrink-0 truncate font-mono text-[12.5px] text-muted-foreground">
                    {destination.href}
                  </span>
                </a>
              </motion.li>
            ))}
          </ul>

          {matches.length === 0 && (
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={SPRING_FLUID}
              className="py-3 text-center text-[13.5px] text-muted-foreground"
            >
              Nothing here matches that either.
            </motion.p>
          )}
        </div>
      </EmptyState>
    </EmptyPanel>
  );
}
