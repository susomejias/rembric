import { RefreshCw } from 'lucide-react';
import Link from 'next/link';

import { getUpdates } from './update-service';

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
import { REMBRIC_VERSION } from '@/lib/version';

/**
 * The update view, in the production dashboard's composition: the numbered view
 * head, the version line and the release card.
 *
 * `apps/server`'s view had two faces: this one, and the in-process self-upgrade
 * (Docker pull, restart, progress polling). The retired second face is not part
 * of this port either, so this reads the release feed through
 * `UpdateCheckService.peek()` — cached result plus a background refresh when the
 * 24h window has passed — and renders whatever it finds.
 *
 * The manual check (`POST /dashboard/update/check`) is not wired: it is a
 * mutation-shaped action whose Server Action boundary is a separate slice. The
 * card states its honest outcome as copy and its control stays disabled.
 */
export const dynamic = 'force-dynamic';

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

      <button
        type="button"
        disabled
        title="The manual check is wired in a later slice"
        className="mt-5 flex items-center gap-3 border border-border px-5 py-4 font-mono text-[11px] font-semibold uppercase tracking-[.16em] text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
      >
        <RefreshCw className="size-3.5" />
        Check now <span aria-hidden="true">→</span>
      </button>

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
          v="Not wired"
          sub={<span>THE SERVER ACTION BOUNDARY IS A SEPARATE SLICE</span>}
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
        </div>
      ) : null}
    </Page>
  );
}

/**
 * The three outcomes of a manual check, plus the `err` codes the retired start
 * action could redirect with. Only `no_update` can still occur now that the
 * orchestrator is retired; the rest are kept so an old bookmark or a lagging
 * redirect renders a sentence instead of a raw code. An unrecognised `checked`
 * value flashes nothing, exactly as before.
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
