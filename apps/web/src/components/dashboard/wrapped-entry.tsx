'use client';

import { ArrowUpRight } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef } from 'react';

import { buttonVariants } from '@/components/ui/button';

export function WrappedEntry() {
  const link = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (window.location.hash === '#wrapped-entry') link.current?.focus({ preventScroll: true });
  }, []);
  return (
    <Link ref={link} id="wrapped-entry" href="/dashboard/wrapped" className="wrapped-entry">
      <div className="wrapped-entry-copy">
        <p className="mb-2 font-mono text-[10px] tracking-[.14em] text-primary">REMBRIC WRAPPED</p>
        <h2 className="text-5xl font-semibold leading-[1.02] tracking-[-.05em]">
          Your year.
          <br />
          <span className="text-primary">Wrapped.</span>
        </h2>
        <span className={buttonVariants({ size: 'lg', className: 'mt-5' })}>
          Play your recap
          <ArrowUpRight data-icon="inline-end" aria-hidden="true" />
        </span>
      </div>
      <div className="wrapped-entry-art" aria-hidden="true">
        <div className="wrapped-entry-story wrapped-entry-story-back">
          <span className="wrapped-entry-bars">
            <i />
            <i />
            <i />
            <i />
          </span>
        </div>
        <div className="wrapped-entry-story wrapped-entry-story-front">
          <span className="wrapped-entry-story-progress">
            <i />
            <i />
            <i />
            <i />
          </span>
          <Image src="/dashboard/assets/logo-transparent.png" alt="" width={72} height={72} />
          <span className="font-semibold text-2xl leading-none tracking-tight">
            Your year.
            <br />
            <span className="text-primary">Wrapped.</span>
          </span>
        </div>
      </div>
    </Link>
  );
}
