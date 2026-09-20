import Link from 'next/link';

import { getUpdates } from './update-service';

import { singleParam } from '@/components/dashboard/format';
import { Markdown } from '@/components/dashboard/markdown';
import { Timestamp } from '@/components/dashboard/timestamp';
import { ViewHead } from '@/components/dashboard/view-head';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { REMBRIC_VERSION } from '@/lib/version';

/**
 * The update view — the version card and the badge, ported without the
 * self-upgrade orchestrator.
 *
 * `apps/server`'s view had two faces: this one, and the in-process self-upgrade
 * (Docker pull, restart, progress polling). The change retires the second
 * (`tasks.md` 11.3), so the ported view reads the release feed through
 * `UpdateCheckService.peek()` — which returns the cached result and kicks the
 * background refresh when the 24h window has passed — and renders whatever it
 * finds. No capability probe, no deployment-layer path, no progress script, and
 * above all no in-app update trigger in any state.
 *
 * The manual check (`POST /dashboard/update/check`) is not wired: it is a
 * mutation-shaped action whose confirmation/Csrf boundary belongs to the
 * Server Action slice. The card renders its three honest outcomes as copy and
 * its control disabled, exactly as the retired view worded them.
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
    <div className="flex flex-col gap-4">
      <ViewHead title="Rembric Updates." />

      {notice ? (
        <Card
          className={
            notice.tone === 'error' ? 'border-destructive/40 bg-destructive/5 py-3' : 'py-3'
          }
        >
          <CardContent className="flex flex-wrap items-center gap-2 text-sm">
            <Badge
              variant="outline"
              className={
                notice.tone === 'error'
                  ? 'border-destructive/50 font-mono text-destructive'
                  : 'border-primary/50 font-mono text-brand-accent'
              }
            >
              {notice.label}
            </Badge>
            <span>{notice.body}</span>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Card className="gap-2">
          <CardHeader>
            <CardTitle className="font-mono text-xs tracking-[0.18em] text-muted-foreground uppercase">
              Current version
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            <span className="font-display text-3xl font-semibold tabular-nums">
              v{REMBRIC_VERSION}
            </span>
            <VersionBadge enabled={enabled} latest={info?.latestVersion ?? null} />
          </CardContent>
        </Card>

        <Card className="gap-2">
          <CardHeader>
            <CardTitle className="font-mono text-xs tracking-[0.18em] text-muted-foreground uppercase">
              Last checked
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
            <span>
              {lastChecked ? <Timestamp value={lastChecked} /> : 'Not checked yet in this process.'}
            </span>
            <Button variant="outline" disabled>
              CHECK NOW →
            </Button>
          </CardContent>
        </Card>
      </div>

      {info ? (
        <Card className="gap-3">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2 font-heading text-base">
              Release v{info.latestVersion}
              {info.publishedAt ? (
                <span className="font-mono text-xs font-normal text-muted-foreground">
                  PUBLISHED <Timestamp value={info.publishedAt} />
                </span>
              ) : null}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            {info.releaseUrl ? (
              <Link
                href={info.releaseUrl}
                className="w-fit text-brand-accent underline-offset-4 hover:underline"
              >
                Open the release on GitHub →
              </Link>
            ) : null}
            {info.changelog.trim().length > 0 ? (
              <div className="rounded-xl border bg-muted/40 p-3">
                <Markdown content={info.changelog} />
              </div>
            ) : (
              <p className="text-muted-foreground">The release carries no changelog body.</p>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card className="gap-2 py-3">
        <CardContent className="text-sm text-muted-foreground">
          {!enabled ? (
            <p>
              This deployment sets <code className="font-mono">REMBRIC_UPDATE_CHECK=off</code>, so
              Rembric never contacts GitHub and cannot know whether{' '}
              <code className="font-mono">v{REMBRIC_VERSION}</code> is the latest release. Remove
              the variable and restart to re-enable the check.
            </p>
          ) : info ? (
            <p>
              A newer release is known. The badge follows the cached result of the daily check; the
              manual check is not wired in this slice.
            </p>
          ) : (
            <p>
              You are running <code className="font-mono">v{REMBRIC_VERSION}</code> — no newer
              release is known. The check runs automatically at most once a day and can be disabled
              with <code className="font-mono">REMBRIC_UPDATE_CHECK=off</code>.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function VersionBadge({ enabled, latest }: { enabled: boolean; latest: string | null }) {
  if (!enabled) {
    return (
      <Badge variant="secondary" className="font-mono text-muted-foreground">
        CHECK DISABLED
      </Badge>
    );
  }
  if (latest) {
    return (
      <Badge variant="outline" className="border-warn/50 font-mono text-warn">
        UPDATE AVAILABLE · v{latest}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-primary/50 font-mono text-brand-accent">
      UP TO DATE
    </Badge>
  );
}

/**
 * The three outcomes of a manual check, plus the `err` codes the retired start
 * action could redirect with. Only `no_update` can still occur now that the
 * orchestrator is retired (`not_available` / `already_running` / `backup_failed`
 * described starting an update, which no longer exists); the rest are kept so an
 * old bookmark or a lagging redirect renders a sentence instead of a raw code.
 * An unrecognised `checked` value flashes nothing, exactly as before.
 */
function noticeFrom(
  params: SearchParams,
): { tone: 'error' | 'success'; label: string; body: string } | null {
  const err = singleParam(params.err);
  if (err !== '') {
    return { tone: 'error', label: 'ERROR', body: updateErrorText(err) };
  }
  const checked = singleParam(params.checked);
  if (checked === 'none') {
    return {
      tone: 'success',
      label: 'CHECKED',
      body: 'Checked — no newer release is known.',
    };
  }
  if (checked === 'error') {
    return {
      tone: 'error',
      label: 'CHECK FAILED',
      body: 'The release check could not reach GitHub (offline or rate-limited) — this is expected on air-gapped hosts.',
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
