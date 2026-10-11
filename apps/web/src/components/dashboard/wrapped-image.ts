import type { MemoryType, WrappedStats } from '@rembric/db';

export const WRAPPED_TYPE_LABELS: Record<MemoryType, string> = {
  user: 'Preferences',
  feedback: 'Feedback',
  project: 'Project knowledge',
  reference: 'References',
  procedural: 'Procedures',
};

export const WRAPPED_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
export const WRAPPED_IMAGE_SIZES = {
  square: { width: 1080, height: 1080 },
  story: { width: 1080, height: 1920 },
} as const;
export type WrappedImageFormat = keyof typeof WRAPPED_IMAGE_SIZES;
const compactCount = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
export const formatWrappedCount = (n: number) => compactCount.format(n).replace('K', 'k');

export async function createWrappedImage(
  data: WrappedStats,
  format: WrappedImageFormat,
): Promise<Blob> {
  const { width, height } = WRAPPED_IMAGE_SIZES[format];
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Image export is unavailable in this browser.');
  const styles = getComputedStyle(document.documentElement);
  const sans = styles.getPropertyValue('--font-geist').trim();
  const mono = styles.getPropertyValue('--font-geist-mono').trim();
  if (!sans || !mono) throw new Error('The Rembric fonts are not ready. Please retry.');
  await Promise.all([
    document.fonts.load(`600 96px ${sans}`),
    document.fonts.load(`600 24px ${mono}`),
  ]);
  await document.fonts.ready;
  if (!document.fonts.check(`600 96px ${sans}`))
    throw new Error('The Rembric font could not be loaded. Please retry.');
  const logo = new Image();
  logo.src = '/dashboard/assets/logo-transparent.png';
  await logo.decode();

  const story = format === 'story';
  const heroY = story ? 252 : 160;
  const heroHeight = story ? 630 : 392;
  const metricY = story ? 1060 : 674;
  const activityY = story ? 1240 : 814;
  const summaryY = story ? 1560 : 944;
  const context = ctx;
  function text(
    value: string,
    x: number,
    y: number,
    size: number,
    color = '#fafafa',
    font = sans,
    maxWidth = 904,
  ) {
    context.font = `600 ${size}px ${font}`;
    while (context.measureText(value).width > maxWidth && size > 12)
      context.font = `600 ${--size}px ${font}`;
    context.fillStyle = color;
    context.fillText(value, x, y);
  }
  function panel(x: number, y: number, w: number, h: number, color = '#101012') {
    context.fillStyle = color;
    context.beginPath();
    context.roundRect(x, y, w, h, 16);
    context.fill();
  }

  ctx.fillStyle = '#09090b';
  ctx.fillRect(0, 0, width, height);
  const glow = ctx.createRadialGradient(940, heroY, 0, 940, heroY, 1100);
  glow.addColorStop(0, 'rgba(198,242,78,.1)');
  glow.addColorStop(1, 'rgba(198,242,78,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);
  const brandY = story ? 138 : 88;
  ctx.drawImage(logo, 80, brandY - 34, 44, 44);
  text('rembric', 138, brandY, 32);
  ctx.textAlign = 'right';
  text(`Wrapped / ${data.year}`, 1000, brandY, 24, '#a1a1aa', mono, 360);
  ctx.textAlign = 'left';

  ctx.save();
  ctx.translate(540, heroY + heroHeight / 2);
  ctx.rotate((-3 * Math.PI) / 180);
  ctx.shadowColor = 'rgba(0,0,0,.4)';
  ctx.shadowBlur = 44;
  ctx.shadowOffsetY = 24;
  panel(-494, -heroHeight / 2, 988, heroHeight, '#c6f24e');
  ctx.shadowColor = 'transparent';
  text(
    'Your year.',
    -424,
    -heroHeight / 2 + (story ? 122 : 78),
    story ? 112 : 66,
    '#09090b',
    sans,
    470,
  );
  text(
    'Wrapped.',
    -424,
    -heroHeight / 2 + (story ? 238 : 146),
    story ? 112 : 66,
    '#09090b',
    sans,
    470,
  );
  text(
    formatWrappedCount(data.memories),
    -434,
    heroHeight / 2 - 72,
    story ? 246 : 156,
    '#09090b',
    sans,
    442,
  );
  text('memories saved', -424, heroHeight / 2 - 28, story ? 26 : 21, '#353e1b', mono, 430);

  const types = (Object.keys(WRAPPED_TYPE_LABELS) as MemoryType[])
    .map((type) => ({ label: WRAPPED_TYPE_LABELS[type], n: data.types[type] }))
    .filter((row) => row.n > 0)
    .sort((a, b) => b.n - a.n);
  text('Memory mix', 70, story ? -164 : -144, 22, '#353e1b', mono, 350);
  const maxType = Math.max(1, ...types.map((row) => row.n));
  types.forEach((row, i) => {
    const y = (story ? -110 : -96) + i * (story ? 76 : 52);
    text(row.label, 70, y, story ? 21 : 18, '#09090b', sans, 260);
    ctx.textAlign = 'right';
    text(formatWrappedCount(row.n), 430, y, story ? 21 : 18, '#09090b', mono, 90);
    ctx.textAlign = 'left';
    panel(70, y + 13, 360, story ? 22 : 16, 'rgba(9,9,11,.1)');
    panel(70, y + 13, (360 * row.n) / maxType, story ? 22 : 16, '#09090b');
  });
  if (types.length === 0) text('No saves yet', 70, 0, 24, '#353e1b', sans, 350);
  ctx.restore();

  const metrics = [
    [data.sessions, 'sessions'],
    [data.judgments, 'judgments'],
    [data.projects, 'active projects'],
  ] as const;
  metrics.forEach(([n, label], i) => {
    const x = 96 + i * 312;
    text(formatWrappedCount(n), x, metricY, story ? 112 : 82, '#fafafa', sans, 258);
    text(label, x, metricY + (story ? 48 : 38), story ? 25 : 21, '#a1a1aa', mono, 270);
  });

  ctx.fillStyle = '#303326';
  ctx.fillRect(96, activityY - (story ? 98 : 60), 888, 1);
  text(formatWrappedCount(data.activeDays), 96, activityY, story ? 62 : 48, '#c6f24e', sans, 220);
  text('active days', 96, activityY + 34, 21, '#a1a1aa', mono, 220);
  text(
    formatWrappedCount(data.longestStreak),
    story ? 746 : 328,
    activityY,
    story ? 62 : 48,
    '#c6f24e',
    sans,
    238,
  );
  text('day streak', story ? 746 : 328, activityY + 34, 21, '#a1a1aa', mono, 238);
  const firstDay = Date.UTC(data.year, 0, 1) / 86_400_000;
  const daysInYear = Date.UTC(data.year + 1, 0, 1) / 86_400_000 - firstDay;
  const counts = new Map(data.days.map((row) => [row.day, row.n]));
  const maxDay = Math.max(1, ...data.days.map((row) => row.n));
  const cellStep = story ? 17 : 8;
  for (let i = 0; i < daysInYear; i++) {
    const n = counts.get(firstDay + i) ?? 0;
    ctx.fillStyle = n > 0 ? `rgba(198,242,78,${0.35 + (0.65 * n) / maxDay})` : '#27272a';
    ctx.fillRect(
      (story ? 96 : 568) + (i % 52) * cellStep,
      (story ? activityY + 92 : activityY - 34) + Math.floor(i / 52) * cellStep,
      story ? 12 : 5,
      story ? 12 : 5,
    );
  }

  ctx.fillStyle = '#303326';
  ctx.fillRect(96, summaryY - 44, 888, 1);
  text('Most sessions', 96, summaryY, 21, '#a1a1aa', mono, 350);
  const topAgent = data.agents[0];
  text(
    topAgent?.agent ?? 'No sessions yet',
    96,
    summaryY + (story ? 100 : 48),
    story ? 52 : 36,
    '#fafafa',
    sans,
    380,
  );
  if (topAgent)
    text(
      `${formatWrappedCount(topAgent.n)} sessions`,
      96,
      summaryY + (story ? 238 : 86),
      20,
      '#c6f24e',
      mono,
      350,
    );
  text('Monthly saves', 540, summaryY, 21, '#a1a1aa', mono, 444);
  const baseline = summaryY + (story ? 214 : 62);
  const peak = Math.max(1, ...data.months);
  data.months.forEach((n, i) => {
    const barHeight = Math.max(3, (n / peak) * (story ? 176 : 36));
    panel(
      540 + i * 38,
      baseline - barHeight,
      26,
      barHeight,
      n > 0 && n === peak ? '#c6f24e' : '#3f3f46',
    );
  });
  text('Jan', 540, baseline + 24, 16, '#a1a1aa', mono);
  ctx.textAlign = 'right';
  text('Dec', 984, baseline + 24, 16, '#a1a1aa', mono);

  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error('Could not generate the PNG. Please retry.')),
      'image/png',
    ),
  );
}
