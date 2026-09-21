import { RefreshCw } from 'lucide-react';
import Link from 'next/link';

import { getUpdates } from './update-service';

import { MarkdownPanel } from '@/components/dashboard/markdown-panel';
import { singleParam } from '@/components/dashboard/support';
import { Notice, Page, PageHead, Panel, Pill, Time } from '@/components/dashboard/ui';
import { REMBRIC_VERSION } from '@/lib/version';

/**
 * The update view, in the v0 composition: the version line, the release card and
 * the disabled manual check.
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
      <PageHead
        icon={RefreshCw}
        eyebrow="Release channel"
        title="Updates"
        description="Check whether a newer Rembric release is available and control how often the local updater checks."
        aside={
          <span className="text-[11px] tracking-[.16em] text-muted-foreground uppercase">
            Rembric v{REMBRIC_VERSION}
          </span>
        }
      />

      {notice ? (
        <Notice
          tone={notice.tone === 'error' ? 'danger' : 'lime'}
          badge={notice.label}
          className="mt-6"
        >
          {notice.body}
        </Notice>
      ) : null}

      <section className="mt-7 max-w-[900px] rounded-2xl border border-border bg-card p-6 md:p-8">
        <p className="text-[10px] tracking-[.18em] text-primary uppercase">
          {!enabled
            ? 'Check disabled'
            : info
              ? `Update available · v${info.latestVersion}`
              : 'Up to date'}
        </p>
        <p className="mt-4 max-w-3xl text-base leading-7 text-muted-foreground">
          {!enabled ? (
            <>
              This deployment sets{' '}
              <code className="border border-primary/30 bg-primary/10 px-2 py-1 text-primary">
                REMBRIC_UPDATE_CHECK=off
              </code>
              , so Rembric never contacts GitHub and cannot know whether{' '}
              <code className="border border-primary/30 bg-primary/10 px-2 py-1 text-primary">
                v{REMBRIC_VERSION}
              </code>{' '}
              is the latest release. Remove the variable and restart to re-enable the check.
            </>
          ) : info ? (
            <>
              You are running{' '}
              <code className="border border-primary/30 bg-primary/10 px-2 py-1 text-primary">
                v{REMBRIC_VERSION}
              </code>{' '}
              and <b className="font-medium text-primary">v{info.latestVersion}</b> is published.
              The upgrade runs on the host, not in this dashboard.
            </>
          ) : (
            <>
              You are running{' '}
              <code className="border border-primary/30 bg-primary/10 px-2 py-1 text-primary">
                v{REMBRIC_VERSION}
              </code>{' '}
              — no newer release is known. The check runs automatically at most once a day and can
              be disabled with{' '}
              <code className="border border-primary/30 bg-primary/10 px-2 py-1 text-primary">
                REMBRIC_UPDATE_CHECK=off
              </code>
              .
            </>
          )}
        </p>
        <p className="mt-7 text-xs tracking-[.16em] text-muted-foreground uppercase">
          Last checked{' '}
          <span className="ml-2 text-muted-foreground normal-case">
            {lastChecked ? <Time value={lastChecked} /> : 'Not checked yet in this process'}
          </span>
        </p>
      </section>

      <button
        type="button"
        disabled
        title="The manual check is wired in a later slice"
        className="mt-5 flex items-center gap-3 border border-border px-5 py-4 text-[11px] font-medium tracking-[.16em] text-muted-foreground uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      >
        <RefreshCw className="size-3.5" />
        Check now <span aria-hidden="true">→</span>
      </button>

      <section className="mt-6 grid gap-3 sm:grid-cols-3">
        <Panel padded>
          <p className="text-[10px] tracking-[.14em] text-muted-foreground uppercase">
            Current version
          </p>
          <p className="mt-2 text-2xl font-medium tracking-[-.05em]">v{REMBRIC_VERSION}</p>
          <p className="mt-1 text-[10px] text-muted-foreground">as reported by this build</p>
        </Panel>
        <Panel padded>
          <p className="text-[10px] tracking-[.14em] text-muted-foreground uppercase">
            Release status
          </p>
          <div className="mt-2">
            <Pill tone={!enabled ? 'dim' : info ? 'amber' : 'lime'}>
              {!enabled
                ? 'Check disabled'
                : info
                  ? `v${info.latestVersion} available`
                  : 'Up to date'}
            </Pill>
          </div>
          <p className="mt-2 text-[10px] text-muted-foreground">cached result of the daily check</p>
        </Panel>
        <Panel padded>
          <p className="text-[10px] tracking-[.14em] text-muted-foreground uppercase">
            Manual check
          </p>
          <p className="mt-2 text-sm text-muted-foreground">Not wired</p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            the Server Action boundary is a separate slice
          </p>
        </Panel>
      </section>

      {info ? (
        <>
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
                  className="rounded-lg border border-border bg-accent px-3 py-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  Open on GitHub
                </Link>
              ) : null
            }
          />
          {info.publishedAt ? (
            <p className="mt-3 text-[11px] text-muted-foreground">
              Published <Time value={info.publishedAt} />
            </p>
          ) : null}
        </>
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
