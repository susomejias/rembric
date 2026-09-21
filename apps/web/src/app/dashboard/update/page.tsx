import Link from 'next/link';

import { checkForUpdates, UPDATE_CHECK_FORM } from './actions';
import { CopyCommand } from './copy-command';
import { getUpdates } from './update-service';

import { ActionForm } from '@/components/dashboard/action-form';
import { CsrfField } from '@/components/dashboard/csrf-field';
import { MarkdownPanel } from '@/components/dashboard/markdown-panel';
import { singleParam } from '@/components/dashboard/support';
import {
  Flash,
  Page,
  Pill,
  SectionBar,
  StatCard,
  StatGrid,
  Time,
  ViewHead,
} from '@/components/dashboard/ui';
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
      <ViewHead
        num="09"
        title="Rembric Updates."
        hl="Rembric"
        meta={[{ k: 'RUNNING', v: `v${REMBRIC_VERSION}` }]}
      />

      {notice ? (
        <div className="mt-5">
          <Flash tone={notice.tone === 'error' ? 'danger' : 'lime'} label={notice.label}>
            {notice.body}
          </Flash>
        </div>
      ) : null}

      <section className="mt-6 max-w-[900px] border border-border bg-card p-6 md:p-8">
        <p className="font-mono text-[11px] uppercase tracking-[.16em] text-primary">
          {!enabled
            ? 'CHECK DISABLED'
            : info
              ? `UPDATE AVAILABLE · v${info.latestVersion}`
              : 'UP TO DATE'}
        </p>
        <p className="mt-4 max-w-3xl text-base leading-7 text-muted-foreground">
          {!enabled ? (
            <>
              This deployment sets{' '}
              <code className="border border-primary/40 bg-primary/10 px-2 py-1 text-primary">
                REMBRIC_UPDATE_CHECK=off
              </code>
              , so Rembric never contacts GitHub and cannot know whether{' '}
              <code className="border border-primary/40 bg-primary/10 px-2 py-1 text-primary">
                v{REMBRIC_VERSION}
              </code>{' '}
              is the latest release. Remove the variable and restart to re-enable the check.
            </>
          ) : info ? (
            <>
              You are running{' '}
              <code className="border border-primary/40 bg-primary/10 px-2 py-1 text-primary">
                v{REMBRIC_VERSION}
              </code>{' '}
              and <b className="font-medium text-primary">v{info.latestVersion}</b> is published.
              The upgrade runs on the host, not in this dashboard.
            </>
          ) : (
            <>
              You are running{' '}
              <code className="border border-primary/40 bg-primary/10 px-2 py-1 text-primary">
                v{REMBRIC_VERSION}
              </code>{' '}
              — no newer release is known. The check runs automatically at most once a day and can
              be disabled with{' '}
              <code className="border border-primary/40 bg-primary/10 px-2 py-1 text-primary">
                REMBRIC_UPDATE_CHECK=off
              </code>
              .
            </>
          )}
        </p>
        <p className="mt-7 font-mono text-[11px] uppercase tracking-[.16em] text-muted-foreground">
          LAST CHECKED{' '}
          <span className="ml-2 font-sans text-sm tracking-normal normal-case">
            {lastChecked ? <Time value={lastChecked} /> : 'not checked yet in this process'}
          </span>
        </p>
      </section>

      {/* The check has nothing new to say once a release is known. */}
      {enabled && info === null ? (
        <ActionForm action={checkForUpdates} className="mt-5">
          <CsrfField form={UPDATE_CHECK_FORM} />
          <Button type="submit" variant="outline" size="sm">
            CHECK NOW →
          </Button>
        </ActionForm>
      ) : null}

      <StatGrid className="mt-6 sm:grid-cols-3 xl:grid-cols-3">
        <StatCard
          k="CURRENT VERSION"
          v={`v${REMBRIC_VERSION}`}
          tone="lime"
          sub={<span>AS REPORTED BY THIS BUILD</span>}
        />
        <StatCard
          k="RELEASE STATUS"
          v={
            <Pill tone={!enabled ? 'dim' : info ? 'amber' : 'lime'}>
              {!enabled
                ? 'Check disabled'
                : info
                  ? `v${info.latestVersion} available`
                  : 'Up to date'}
            </Pill>
          }
          sub={<span>CACHED RESULT OF THE DAILY CHECK</span>}
        />
        <StatCard
          k="MANUAL CHECK"
          v={enabled ? 'On demand' : 'Unavailable'}
          sub={<span>{enabled ? 'FORCES A RELEASE CHECK NOW' : 'THE CHECK IS TURNED OFF'}</span>}
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
                  className="border border-border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[.12em] text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                >
                  Open on GitHub
                </Link>
              ) : null
            }
          />
          {info.publishedAt ? (
            <p className="font-mono text-[11px] uppercase tracking-[.12em] text-muted-foreground">
              PUBLISHED <Time value={info.publishedAt} />
            </p>
          ) : null}

          <div className="mt-6 max-w-[900px] border border-border bg-card p-5 md:p-6">
            <p className="font-mono text-[11px] uppercase tracking-[.16em] text-primary">
              MANUAL UPDATE
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
              className="mt-4 inline-block font-mono text-[11px] uppercase tracking-[.12em] text-muted-foreground transition-colors hover:text-primary"
            >
              HOW TO ENABLE ONE-CLICK UPDATES ›
            </a>
          </div>
        </div>
      ) : null}
    </Page>
  );
}

/**
 * `err` codes are still mapped for an old bookmark or a lagging redirect; only
 * `none` can occur now.
 */
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
