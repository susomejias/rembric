'use client';

import type { UpdatePhase } from '@rembric/core';
import { useEffect, useState } from 'react';

import { Flash, LABEL } from '@/components/dashboard/ui';
import { cn } from '@/lib/utils';

const STEP_DEFS = [
  { key: 'backup', label: 'Back up database' },
  { key: 'pull', label: 'Pull new image' },
  { key: 'restart', label: 'Restart service' },
  { key: 'verify', label: 'Verify new version' },
] as const;

type StepKey = (typeof STEP_DEFS)[number]['key'];
type StepState = 'idle' | 'active' | 'done';
type StepStates = Record<StepKey, StepState>;

const IDLE_STATES: StepStates = { backup: 'idle', pull: 'idle', restart: 'idle', verify: 'idle' };

const DOT: Record<StepState, string> = {
  idle: 'border-border bg-transparent',
  active: 'border-primary bg-primary/40',
  done: 'border-primary bg-primary',
};

const TEXT: Record<StepState, string> = {
  idle: 'text-muted-foreground',
  active: 'text-primary',
  done: 'text-foreground',
};

const PHASES: readonly UpdatePhase[] = ['idle', 'backup', 'pull', 'launch', 'restarting', 'failed'];

const STATUS_PATH = '/dashboard/update/status';
const VERSION_PATH = '/dashboard/update/version';
const REDIRECT_PATH = '/dashboard';
const STATUS_INTERVAL_MS = 1500;
const VERSION_INTERVAL_MS = 2000;
const PROBE_TIMEOUT_MS = 4000;
const SAME_VERSION_MISSES = 2;

interface ProgressPayload {
  phase: UpdatePhase;
  error: string | null;
  pull: { done: number; total: number } | null;
  targetVersion: string | null;
}

export interface UpdateProgressPreview {
  phase: UpdatePhase;
  pull: { done: number; total: number } | null;
}

export function UpdateProgress({
  initialVersion,
  preview,
}: {
  initialVersion: string;
  preview: UpdateProgressPreview | null;
}) {
  const previewPhase = preview?.phase ?? null;
  const [steps, setSteps] = useState<StepStates>(() => statesForPhase(previewPhase));
  const [pull, setPull] = useState<{ done: number; total: number } | null>(preview?.pull ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (previewPhase !== null) return;

    let cancelled = false;
    let verifying = false;
    let sawDown = false;
    let sameVersionSeen = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (fn: () => void, delayMs: number): void => {
      timer = setTimeout(fn, delayMs);
    };

    const probe = async (url: string): Promise<unknown> => {
      const response = await fetch(url, {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const payload: unknown = await response.json();
      return payload;
    };

    const verifyTick = (): void => {
      probe(VERSION_PATH)
        .then((payload) => {
          if (cancelled) return;
          const version = readVersion(payload);
          if (version !== null && version !== initialVersion) {
            setSteps((current) => ({ ...current, restart: 'done', verify: 'done' }));
            window.location.replace(REDIRECT_PATH);
            return;
          }
          if (sawDown) {
            sameVersionSeen += 1;
            if (sameVersionSeen >= SAME_VERSION_MISSES) {
              setSteps((current) => ({ ...current, restart: 'done', verify: 'idle' }));
              setError(rollbackText(initialVersion));
              return;
            }
          }
          schedule(verifyTick, VERSION_INTERVAL_MS);
        })
        .catch(() => {
          if (cancelled) return;
          sawDown = true;
          schedule(verifyTick, VERSION_INTERVAL_MS);
        });
    };

    const statusTick = (): void => {
      if (verifying) return;
      probe(STATUS_PATH)
        .then((payload) => {
          if (cancelled) return;
          const status = readStatus(payload);
          if (status === null) {
            schedule(statusTick, STATUS_INTERVAL_MS);
            return;
          }
          if (status.phase === 'failed') {
            setSteps({ ...IDLE_STATES });
            setError(status.error ?? 'The update failed before it could hand off.');
            return;
          }
          if (status.phase === 'backup') {
            setSteps((current) => ({ ...current, backup: 'active' }));
          }
          if (status.phase === 'pull') {
            setSteps((current) => ({ ...current, backup: 'done', pull: 'active' }));
            if (status.pull !== null) setPull(status.pull);
          }
          if (status.phase === 'launch' || status.phase === 'restarting') {
            setSteps((current) => ({
              ...current,
              backup: 'done',
              pull: 'done',
              restart: 'active',
            }));
            if (status.phase === 'restarting') {
              verifying = true;
              setSteps((current) => ({ ...current, verify: 'active' }));
              verifyTick();
              return;
            }
          }
          schedule(statusTick, STATUS_INTERVAL_MS);
        })
        .catch(() => {
          if (cancelled) return;
          verifying = true;
          setSteps({ backup: 'done', pull: 'done', restart: 'active', verify: 'active' });
          verifyTick();
        });
    };

    statusTick();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [initialVersion, previewPhase]);

  return (
    <div>
      {error === null ? null : (
        <Flash tone="danger" label="Update failed">
          {error}
        </Flash>
      )}
      <div className="flex flex-col gap-3">
        {STEP_DEFS.map((step) => (
          <div
            key={step.key}
            data-step={step.key}
            data-state={steps[step.key]}
            className="flex items-center gap-3"
          >
            <span
              aria-hidden="true"
              className={cn('size-2.5 shrink-0 rounded-full border', DOT[steps[step.key]])}
            />
            <span className={cn(LABEL, TEXT[steps[step.key]])}>{step.label}</span>
            {step.key === 'pull' && pull !== null ? (
              <span data-pull-progress className={cn(LABEL, 'text-muted-foreground')}>
                {pull.done}/{pull.total} layers
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function statesForPhase(phase: UpdatePhase | null): StepStates {
  switch (phase) {
    case 'backup':
      return { ...IDLE_STATES, backup: 'active' };
    case 'pull':
      return { ...IDLE_STATES, backup: 'done', pull: 'active' };
    case 'launch':
      return { ...IDLE_STATES, backup: 'done', pull: 'done', restart: 'active' };
    case 'restarting':
      return { ...IDLE_STATES, backup: 'done', pull: 'done', restart: 'active', verify: 'active' };
    default:
      return { ...IDLE_STATES };
  }
}

function rollbackText(initialVersion: string): string {
  return `The update did not complete — the server is still on v${initialVersion} (the upgrader rolled back). Check the upgrader container logs on the host.`;
}

function isPhase(value: string): value is UpdatePhase {
  return PHASES.some((phase) => phase === value);
}

function readStatus(payload: unknown): ProgressPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const phase = record['phase'];
  if (typeof phase !== 'string' || !isPhase(phase)) return null;
  return {
    phase,
    error: typeof record['error'] === 'string' ? record['error'] : null,
    pull: readPull(record['pull']),
    targetVersion: typeof record['targetVersion'] === 'string' ? record['targetVersion'] : null,
  };
}

function readVersion(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const version = (payload as Record<string, unknown>)['version'];
  return typeof version === 'string' && version !== '' ? version : null;
}

function readPull(value: unknown): { done: number; total: number } | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const done = record['done'];
  const total = record['total'];
  if (typeof done !== 'number' || typeof total !== 'number') return null;
  return { done, total };
}
