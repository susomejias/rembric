import type { UpdateInfo } from '@rembric/core';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { checkForUpdates, UPDATE_CHECK_FORM } from './actions';
import { CopyCommand } from './copy-command';
import { getUpdates } from './update-service';

import { ActionForm } from '@/components/dashboard/action-form';
import { CsrfField } from '@/components/dashboard/csrf-field';
import { MarkdownPanel } from '@/components/dashboard/markdown-panel';
import { singleParam } from '@/components/dashboard/support';
import { Flash, Page, Pill, SectionBar, StatCard, StatGrid, Time } from '@/components/dashboard/ui';
import { Button } from '@/components/ui/button';
import { REMBRIC_VERSION } from '@/lib/version';

export const dynamic = 'force-dynamic';

const MANUAL_UPDATE_COMMAND = 'docker compose pull && docker compose up -d';
const UPDATE_DOCS_URL = 'https://github.com/susomejias/rembric/blob/main/docs/updates.md';

type SearchParams = Record<string, string | string[] | undefined>;

export default async function UpdatePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const updates = getUpdates();
  const enabled = updates.enabled;
  const info = updates.peek();
  const lastChecked = updates.lastCheckedAt;
  const notice = noticeFrom(params);

  return (
    <Page>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Updates</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Running Rembric v{REMBRIC_VERSION} · {statusLine(enabled, info)}
          </p>
        </div>
        {enabled && info === null ? (
          <ActionForm action={checkForUpdates} className="shrink-0">
            <CsrfField form={UPDATE_CHECK_FORM} />
            <Button type="submit">Check for updates</Button>
          </ActionForm>
        ) : null}
      </header>

      {notice ? (
        <div className="mt-5">
          <Flash tone={notice.tone === 'error' ? 'danger' : 'lime'} label={notice.label}>
            {notice.body}
          </Flash>
        </div>
      ) : null}

      <section className="mt-6 max-w-[900px] rounded-2xl border border-border bg-card p-6 md:p-8">
        <p className="font-mono text-[11px] uppercase tracking-[.14em] text-primary">
          {!enabled
            ? 'Check disabled'
            : info
              ? `Update available · v${info.latestVersion}`
              : 'Up to date'}
        </p>
        <p className="mt-4 max-w-3xl text-base leading-7 text-muted-foreground">
          {!enabled ? (
            <>
              This deployment sets <VersionCode>REMBRIC_UPDATE_CHECK=off</VersionCode>, so Rembric
              never contacts GitHub and cannot know whether{' '}
              <VersionCode>v{REMBRIC_VERSION}</VersionCode> is the latest release. Remove the
              variable and restart to re-enable the check.
            </>
          ) : info ? (
            <>
              You are running <VersionCode>v{REMBRIC_VERSION}</VersionCode> and{' '}
              <b className="font-medium text-primary">v{info.latestVersion}</b> is published. The
              upgrade runs on the host, not in this dashboard.
            </>
          ) : (
            <>
              You are running <VersionCode>v{REMBRIC_VERSION}</VersionCode> — no newer release is
              known. The check runs automatically at most once a day and can be disabled with{' '}
              <VersionCode>REMBRIC_UPDATE_CHECK=off</VersionCode>.
            </>
          )}
        </p>
        <p className="mt-7 font-mono text-[11px] uppercase tracking-[.14em] text-muted-foreground">
          Last checked{' '}
          <span className="ml-2 font-sans text-sm tracking-normal normal-case">
            {lastChecked ? <Time value={lastChecked} /> : 'not checked yet in this process'}
          </span>
        </p>
      </section>

      <StatGrid className="mt-6 sm:grid-cols-3 xl:grid-cols-3">
        <StatCard
          k="Current version"
          v={`v${REMBRIC_VERSION}`}
          tone="lime"
          sub={<span>As reported by this build</span>}
        />
        <StatCard
          k="Release status"
          v={
            <Pill tone={!enabled ? 'dim' : info ? 'amber' : 'lime'}>
              {!enabled
                ? 'Check disabled'
                : info
                  ? `v${info.latestVersion} available`
                  : 'Up to date'}
            </Pill>
          }
          sub={<span>Cached result of the daily check</span>}
        />
        <StatCard
          k="Manual check"
          v={enabled ? 'On demand' : 'Unavailable'}
          sub={<span>{enabled ? 'Forces a release check now' : 'The check is turned off'}</span>}
        />
      </StatGrid>

      {info ? (
        <div className="mt-8">
          <SectionBar name={`Release v${info.latestVersion}`} meta="RELEASE NOTES" />
          <MarkdownPanel
            eyebrow={`Release v${info.latestVersion}`}
            title="Release notes"
            markdown={
              info.changelog.trim().length > 0
                ? `# v${info.latestVersion}\n\n${info.changelog}`
                : `# v${info.latestVersion}\n\nThis release carries no changelog body.`
            }
            copyLabel="Copy changelog"
            action={
              info.releaseUrl ? (
                <Link
                  href={info.releaseUrl}
                  className="rounded-xl border border-border px-3.5 py-2 text-sm text-foreground transition-colors hover:bg-accent"
                >
                  Open on GitHub
                </Link>
              ) : null
            }
          />
          {info.publishedAt ? (
            <p className="font-mono text-[11px] uppercase tracking-[.14em] text-muted-foreground">
              Published <Time value={info.publishedAt} />
            </p>
          ) : null}

          <div className="mt-6 max-w-[900px] rounded-2xl border border-border bg-card p-5 md:p-6">
            <p className="font-mono text-[11px] uppercase tracking-[.14em] text-primary">
              Manual update
            </p>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
              Run this on the host, then this page will reload on the new version:
            </p>
            <div className="mt-4">
              <CopyCommand command={MANUAL_UPDATE_COMMAND} />
            </div>
            <a
              href={UPDATE_DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-block font-mono text-[11px] uppercase tracking-[.14em] text-muted-foreground transition-colors hover:text-primary"
            >
              How to enable one-click updates ›
            </a>
          </div>
        </div>
      ) : null}
    </Page>
  );
}

function VersionCode({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-md border border-primary/40 bg-primary/10 px-2 py-1 text-primary">
      {children}
    </code>
  );
}

function statusLine(enabled: boolean, info: UpdateInfo | null): string {
  if (!enabled) return 'update check disabled';
  return info ? `v${info.latestVersion} is available` : 'up to date';
}

function noticeFrom(
  params: SearchParams,
): { tone: 'error' | 'success'; label: string; body: string } | null {
  const err = singleParam(params['err']);
  if (err !== '') {
    return { tone: 'error', label: 'Error', body: updateErrorText(err) };
  }
  const checked = singleParam(params['checked']);
  if (checked === 'none') {
    return { tone: 'success', label: 'Checked', body: 'Checked — no newer release is known.' };
  }
  if (checked === 'error') {
    return {
      tone: 'error',
      label: 'Check failed',
      body: 'The release check could not reach GitHub (offline or rate-limited) — expected on air-gapped hosts.',
    };
  }
  return null;
}

function updateErrorText(code: string): string {
  switch (code) {
    case 'not_available':
      return 'One-click update is not available on this deployment (no usable Docker socket or pinned image tag).';
    case 'already_running':
      return 'An update is already in progress.';
    case 'backup_failed':
      return 'The pre-update database backup failed; the update was aborted before touching any container.';
    case 'no_update':
      return 'No update is currently known.';
    default:
      return 'The update could not be started.';
  }
}
