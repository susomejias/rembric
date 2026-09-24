import type { SelfUpdateCapability, UpdateInfo, UpdateStatus } from '@rembric/core';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { checkForUpdates, startUpdate, UPDATE_CHECK_FORM, UPDATE_START_FORM } from './actions';
import { CopyCommand } from './copy-command';
import { getSelfUpdate, isUpdateRunning } from './self-update-service';
import { UpdateProgress } from './update-progress';
import { getUpdates } from './update-service';

import { ActionForm } from '@/components/dashboard/action-form';
import { ConfirmSubmit } from '@/components/dashboard/confirm-submit';
import { CsrfField } from '@/components/dashboard/csrf-field';
import { MarkdownPanel } from '@/components/dashboard/markdown-panel';
import { singleParam } from '@/components/dashboard/support';
import { Flash, Page, Time } from '@/components/dashboard/ui';
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

  const selfUpdate = getSelfUpdate();
  const status = selfUpdate.status();

  if (isUpdateRunning(status)) {
    return <UpdateRun status={status} />;
  }

  const capability = info === null ? null : await selfUpdate.capability();

  return (
    <Page>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Updates</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Running Rembric v{REMBRIC_VERSION} · {statusLine(enabled, info)}
          </p>
        </div>
      </header>

      {notice ? (
        <div className="mt-5">
          <Flash tone={notice.tone === 'error' ? 'danger' : 'lime'} label={notice.label}>
            {notice.body}
          </Flash>
        </div>
      ) : null}

      {!enabled ? (
        <section className="mt-6 max-w-[900px] rounded-2xl border border-border bg-card p-6 md:p-8">
          <p className="font-mono text-[11px] uppercase tracking-[.14em] text-primary">
            Check disabled
          </p>
          <p className="mt-4 max-w-3xl text-base leading-7 text-muted-foreground">
            This deployment sets <VersionCode>REMBRIC_UPDATE_CHECK=off</VersionCode>, so Rembric
            never contacts GitHub and cannot know whether{' '}
            <VersionCode>v{REMBRIC_VERSION}</VersionCode> is the latest release. Remove the variable
            and restart to re-enable the check.
          </p>
          <LastChecked value={lastChecked} />
        </section>
      ) : info ? (
        <section className="mt-6 max-w-[900px] rounded-2xl border border-border bg-card p-6 md:p-8">
          <p className="font-mono text-[11px] uppercase tracking-[.14em] text-primary">
            Update available · v{info.latestVersion}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <VersionCode>v{REMBRIC_VERSION}</VersionCode>
            <span className="text-muted-foreground">→</span>
            <VersionCode>v{info.latestVersion}</VersionCode>
            {info.publishedAt ? (
              <span className="font-mono text-[11px] uppercase tracking-[.14em] text-muted-foreground">
                Published <Time value={info.publishedAt} />
              </span>
            ) : null}
          </div>

          <div className="mt-6">
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
          </div>

          {capability ? <UpdateActionBlock info={info} capability={capability} /> : null}

          <LastChecked value={lastChecked} />
        </section>
      ) : (
        <section className="mt-6 max-w-[900px] rounded-2xl border border-border bg-card p-6 md:p-8">
          <p className="font-mono text-[11px] uppercase tracking-[.14em] text-primary">
            Up to date
          </p>
          <p className="mt-4 max-w-3xl text-base leading-7 text-muted-foreground">
            You are running <VersionCode>v{REMBRIC_VERSION}</VersionCode> — no newer release is
            known. The check runs automatically at most once a day and can be disabled with{' '}
            <VersionCode>REMBRIC_UPDATE_CHECK=off</VersionCode>.
          </p>
          <div className="mt-6">
            <ActionForm action={checkForUpdates}>
              <CsrfField form={UPDATE_CHECK_FORM} />
              <Button type="submit">Check for updates</Button>
            </ActionForm>
          </div>
          <LastChecked value={lastChecked} />
        </section>
      )}
    </Page>
  );
}

function LastChecked({ value }: { value: Date | null }) {
  return (
    <p className="mt-6 font-mono text-[11px] uppercase tracking-[.14em] text-muted-foreground">
      Last checked{' '}
      <span className="ml-2 font-sans text-sm tracking-normal normal-case">
        {value ? <Time value={value} /> : 'not checked yet in this process'}
      </span>
    </p>
  );
}

function UpdateRun({ status }: { status: UpdateStatus }) {
  return (
    <Page>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            Updating Rembric
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Installing <b className="font-medium text-primary">v{status.targetVersion ?? '…'}</b> ·
            usually takes under a minute
          </p>
        </div>
      </header>

      <section className="mt-6 max-w-[900px] rounded-2xl border border-primary/40 bg-card p-6 md:p-8">
        <UpdateProgress initialVersion={REMBRIC_VERSION} />
        <p className="mt-6 max-w-3xl text-sm leading-6 text-muted-foreground">
          Keep this page open — it reloads by itself once the new version answers. If the new
          container fails its health check, the upgrader rolls back to{' '}
          <VersionCode>v{REMBRIC_VERSION}</VersionCode>.
        </p>
      </section>
    </Page>
  );
}

function UpdateActionBlock({
  info,
  capability,
}: {
  info: UpdateInfo;
  capability: SelfUpdateCapability;
}) {
  if (capability.state === 'available') {
    return (
      <div className="mt-6 max-w-[900px] rounded-2xl border border-primary/40 bg-card p-5 md:p-6">
        <p className="font-mono text-[11px] uppercase tracking-[.14em] text-primary">
          One-click update
        </p>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
          Rembric backs up the database, then hands the swap to a short-lived upgrader container:
          stop, replace, restart, verify. Your data and configuration are preserved.
        </p>
        <div className="mt-4">
          <ActionForm action={startUpdate}>
            <CsrfField form={UPDATE_START_FORM} />
            <ConfirmSubmit
              tone="danger"
              title={`Install v${info.latestVersion}?`}
              description={`Rembric will back up the database, stop, replace its container with v${info.latestVersion} and restart. Your data and configuration are preserved.`}
              confirmLabel="UPDATE NOW"
            >
              <Button type="button">UPDATE TO v{info.latestVersion} →</Button>
            </ConfirmSubmit>
          </ActionForm>
        </div>
      </div>
    );
  }

  if (capability.state === 'pinned') {
    return (
      <div className="mt-6 max-w-[900px] rounded-2xl border border-warn/40 bg-card p-5 md:p-6">
        <p className="font-mono text-[11px] uppercase tracking-[.14em] text-warn">
          One-click disabled · image tag pinned
        </p>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
          This deployment pins the image to <VersionCode>:{capability.imageTag ?? ''}</VersionCode>{' '}
          (the <VersionCode>REMBRIC_VERSION</VersionCode> variable in your{' '}
          <VersionCode>.env</VersionCode>). Self-updating would be silently reverted by the next{' '}
          <VersionCode>docker compose up</VersionCode>. Remove the pin and run{' '}
          <VersionCode>docker compose up -d</VersionCode> once to enable one-click updates, or
          update manually:
        </p>
        <div className="mt-4">
          <CopyCommand command={MANUAL_UPDATE_COMMAND} />
        </div>
        <DocsLink />
      </div>
    );
  }

  return (
    <div className="mt-6 max-w-[900px] rounded-2xl border border-border bg-card p-5 md:p-6">
      <p className="font-mono text-[11px] uppercase tracking-[.14em] text-primary">Manual update</p>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
        Run this on the host, then reload this page:
      </p>
      <div className="mt-4">
        <CopyCommand command={MANUAL_UPDATE_COMMAND} />
      </div>
      <DocsLink />
    </div>
  );
}

function DocsLink() {
  return (
    <a
      href={UPDATE_DOCS_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-4 inline-block font-mono text-[11px] uppercase tracking-[.14em] text-muted-foreground transition-colors hover:text-primary"
    >
      How to enable one-click updates ›
    </a>
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
