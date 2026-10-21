'use client';

import { Share2 } from 'lucide-react';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';

import {
  createDetailImage,
  DETAIL_IMAGE_DEFAULTS,
  type DetailImage,
  type DetailImageOptions,
  type DetailShareData,
} from './detail-image';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

const buttonClass =
  'inline-flex min-h-11 items-center justify-center rounded-[10px] border border-border px-4 text-sm focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50';
type Prepared = DetailImage & {
  url: string;
  file: File;
  data: DetailShareData;
  options: DetailImageOptions;
  retry: number;
};

export function DetailShare({ data }: { data: DetailShareData }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<DetailImageOptions>(DETAIL_IMAGE_DEFAULTS);
  const [image, setImage] = useState<Prepared | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    let cancelled = false;
    let url: string | undefined;
    setImage(null);
    setError(null);
    setStatus(null);
    setBusy(false);
    if (open)
      void createDetailImage(data, options)
        .then((result) => {
          if (cancelled) return;
          const file = new File([result.blob], `rembric-${data.kind}.png`, {
            type: 'image/png',
          });
          url = URL.createObjectURL(result.blob);
          setImage({ ...result, url, file, data, options, retry });
        })
        .catch((cause: unknown) => {
          if (!cancelled)
            setError(
              cause instanceof Error ? cause.message : 'Could not prepare the image. Please retry.',
            );
        });
    return () => {
      cancelled = true;
      if (generation.current === current) generation.current++;
      if (url) URL.revokeObjectURL(url);
    };
  }, [open, data, options, retry]);
  const ready =
    open &&
    image !== null &&
    image.data === data &&
    image.options === options &&
    image.retry === retry;
  let nativeShare = false;
  if (ready && typeof navigator.share === 'function') {
    try {
      nativeShare = navigator.canShare?.({ files: [image.file] }) === true;
    } catch {
      nativeShare = false;
    }
  }
  const copySupported =
    typeof ClipboardItem !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard?.write === 'function';
  async function act(kind: 'share' | 'copy') {
    if (!ready || busy || (kind === 'share' ? !nativeShare : !copySupported)) return;
    const current = generation.current;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      if (kind === 'share') await navigator.share({ files: [image.file] });
      else await navigator.clipboard.write([new ClipboardItem({ 'image/png': image.blob })]);
      if (current === generation.current)
        setStatus(kind === 'share' ? 'Image shared.' : 'Image copied.');
    } catch (cause) {
      if (
        current === generation.current &&
        !(cause instanceof Error && cause.name === 'AbortError')
      )
        setError(
          cause instanceof Error ? cause.message : 'Could not complete the action. Please retry.',
        );
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Share2 className="size-3.5" />
          Share
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="h-[min(92dvh,860px)] w-[calc(100%_-_2rem)] max-w-[960px] grid-cols-1 gap-0 overflow-y-auto rounded-2xl border border-border bg-card p-0 shadow-2xl shadow-black/60 sm:max-w-[960px] md:grid-cols-[minmax(0,1fr)_320px] md:grid-rows-[minmax(0,1fr)]"
      >
        <div
          tabIndex={0}
          role="region"
          aria-label="Image preview"
          className="h-[40dvh] min-w-0 overflow-auto bg-background p-5 pt-16 md:h-full md:p-8"
          aria-busy={open && !ready && !error}
        >
          {ready ? (
            <Image
              src={image.url}
              alt="Exact generated PNG preview"
              width={image.width}
              height={image.height}
              unoptimized
              className="mx-auto h-auto w-full rounded-lg"
            />
          ) : (
            <p role="status" className="py-16 text-center text-sm text-[var(--chart-2)]">
              {error ? 'Image unavailable.' : 'Preparing your image…'}
            </p>
          )}
        </div>
        <div className="flex min-h-0 min-w-0 flex-col gap-6 p-6 pt-14 md:overflow-y-auto md:pt-6">
          <div>
            <DialogTitle className="pr-8 text-lg font-semibold">Share {data.kind}</DialogTitle>
            <DialogDescription className="mt-2 text-sm text-[var(--chart-2)]">
              Creates a PNG on your device. Nothing is uploaded until you choose where to send it.
            </DialogDescription>
          </div>
          <fieldset className="grid gap-4">
            <legend className="mb-3 text-sm text-[var(--chart-2)]">Include</legend>
            {(
              ['content', 'project', ...(data.stats?.length ? ['stats' as const] : [])] as const
            ).map((key) => (
              <label
                key={key}
                className="flex min-h-11 cursor-pointer items-center justify-between gap-3 text-sm"
              >
                {key === 'content'
                  ? data.content.label
                  : key === 'project'
                    ? 'Project name'
                    : 'Stats'}
                <span className="relative inline-flex shrink-0">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={options[key]}
                    onChange={(event) => setOptions({ ...options, [key]: event.target.checked })}
                    className="peer sr-only"
                  />
                  <span
                    aria-hidden="true"
                    className="h-5 w-9 rounded-full bg-muted after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-foreground after:transition-transform peer-checked:bg-primary peer-checked:after:translate-x-4 peer-checked:after:bg-primary-foreground peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-primary"
                  />
                </span>
              </label>
            ))}
          </fieldset>
          <div className="mt-auto grid gap-3">
            {ready ? (
              <>
                <p className="text-center font-mono text-xs text-[var(--chart-2)]">
                  PNG · {image.width} × {image.height} · grows to fit
                </p>
                {nativeShare ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void act('share');
                    }}
                    className={`${buttonClass} border-primary bg-primary font-medium text-primary-foreground`}
                  >
                    Share image
                  </button>
                ) : (
                  <a
                    href={image.url}
                    download={image.file.name}
                    className={`${buttonClass} border-primary bg-primary font-medium text-primary-foreground`}
                  >
                    Download PNG
                  </a>
                )}
                <div className="flex flex-wrap gap-2">
                  {nativeShare ? (
                    <a
                      href={image.url}
                      download={image.file.name}
                      className={`${buttonClass} flex-1`}
                    >
                      Download PNG
                    </a>
                  ) : null}
                  {copySupported ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        void act('copy');
                      }}
                      className={`${buttonClass} flex-1`}
                    >
                      Copy image
                    </button>
                  ) : null}
                </div>
              </>
            ) : (
              <button
                type="button"
                disabled={!error}
                onClick={() => setRetry((value) => value + 1)}
                className={buttonClass}
              >
                {error ? 'Retry image' : 'Preparing image…'}
              </button>
            )}
            {error ? (
              <p role="alert" className="break-words text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {status ? (
              <p role="status" className="text-sm text-[var(--chart-2)]">
                {status}
              </p>
            ) : null}
          </div>
        </div>
        <DialogClose asChild>
          <button
            type="button"
            aria-label="Close share dialog"
            className="absolute top-3 right-3 flex size-11 items-center justify-center rounded-[10px] border border-border bg-card focus-visible:outline-2 focus-visible:outline-primary"
          >
            ×
          </button>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}
