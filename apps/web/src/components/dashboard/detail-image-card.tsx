import Image from 'next/image';

import type { DetailImageOptions, DetailShareData } from './detail-image';
import { MarkdownContent } from './markdown-content';

export function DetailImageCard({
  data,
  options,
  logo,
}: {
  data: DetailShareData;
  options: DetailImageOptions;
  logo: string;
}) {
  return (
    <article className="detail-image-card relative isolate box-border min-h-[1080px] w-[1080px] bg-background px-[80px] pt-[60px] pb-[80px] font-sans text-[34px] leading-[53px] text-foreground wrap-anywhere [&_*]:box-border [&_*]:animate-none [&_*]:transition-none">
      <svg
        className="detail-image-constellation absolute top-0 left-0 -z-10"
        width="1080"
        height="290"
        viewBox="0 0 1080 290"
        aria-hidden="true"
      >
        <path
          d="M90 0 260 60 420 30 600 0 780 50 960 0 1010 180 860 260 700 180 150 210Z"
          fill="none"
          stroke="#26262b"
          strokeWidth="2"
        />
        {[
          [90, 0],
          [260, 60],
          [420, 30],
          [600, 0],
          [780, 50],
          [960, 0],
          [1010, 180],
          [860, 260],
          [700, 180],
          [150, 210],
        ].map(([cx, cy], i) => (
          <circle key={i} cx={cx} cy={cy} r="5" fill="#3f3f46" />
        ))}
        <path
          d="M420 30 700 180 780 50 M700 180 860 260"
          fill="none"
          stroke="#c6f24e"
          strokeOpacity=".6"
          strokeWidth="2"
        />
        <circle cx="700" cy="180" r="60" fill="#c6f24e" fillOpacity=".1" />
        <circle cx="700" cy="180" r="30" fill="#c6f24e" fillOpacity=".22" />
        <circle cx="700" cy="180" r="15" fill="#c6f24e" />
      </svg>
      <header className="detail-image-header">
        <div className="detail-image-brand flex h-[44px] items-center gap-[14px] text-[34px] leading-[44px] font-semibold">
          <Image src={logo} width={44} height={44} alt="" unoptimized />
          <span>rembric</span>
        </div>
        <div className="detail-image-meta mt-[96px] flex items-center gap-[26px] font-mono text-[26px] leading-[1.3] text-[var(--chart-2)]">
          <span className="detail-image-label flex min-h-[56px] min-w-[174px] items-center justify-center rounded-full bg-primary px-[20px] py-[10px] font-sans text-[26px] leading-none font-semibold text-primary-foreground">
            {data.label}
          </span>
          <span>
            {new Intl.DateTimeFormat('en-GB', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
              timeZone: 'UTC',
            }).format(data.date)}
            {options.stats && data.duration ? ` · ${data.duration}` : ''}
          </span>
        </div>
        <h1 className="detail-image-title mt-[38px] font-sans text-[76px] leading-[86px] font-semibold tracking-normal text-foreground">
          {data.title}
        </h1>
        <p className="detail-image-byline mt-[28px] text-[28px] leading-[42px] text-[var(--chart-2)]">
          {data.byline}
          {options.project ? ` in ${data.projectName}` : ''}
        </p>
        {data.tags?.length ? (
          <div className="detail-image-tags mt-[32px] flex flex-wrap items-start gap-[14px]">
            {data.tags.map((tag, i) => (
              <span
                key={i}
                className="max-w-full rounded-full border-2 border-[#2a2a30] px-[20px] py-[10px] font-mono text-[26px] leading-[32px]"
              >
                <b className="mr-[2px] font-normal text-primary">#</b>
                {tag}
              </span>
            ))}
          </div>
        ) : null}
        {options.stats && data.stats?.length ? (
          <div className="detail-image-stats mt-[36px] grid grid-cols-3 gap-[16px]">
            {data.stats.map((stat, i) => (
              <div
                key={i}
                className="rounded-[24px] border-2 border-border bg-card px-[24px] py-[22px] text-[26px] text-[var(--chart-2)] first:border-primary first:bg-primary first:text-primary-foreground first:[&>b]:text-primary-foreground"
              >
                <b className="block text-[48px] leading-[58px] font-semibold text-foreground">
                  {stat.value}
                </b>
                <span>{stat.label}</span>
              </div>
            ))}
          </div>
        ) : null}
      </header>
      {options.content && data.content.text ? (
        data.content.mode === 'literal' ? (
          <pre className="detail-image-literal mt-[38px] font-sans text-[34px] leading-[53px] whitespace-pre-wrap text-[#d4d4d8] wrap-anywhere">
            {data.content.text}
          </pre>
        ) : (
          <MarkdownContent markdown={data.content.text} imageExport />
        )
      ) : null}
    </article>
  );
}
