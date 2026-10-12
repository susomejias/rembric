import type { EntityKind, MemoryType, WrappedStats } from '@rembric/db';

const ENTITY_LABELS: Record<EntityKind, string> = {
  path: 'Paths',
  git_ref: 'Git refs',
  url: 'URLs',
  error_code: 'Error codes',
  ticket: 'Tickets',
  cve_id: 'CVEs',
  ip_address: 'IP addresses',
  hostname: 'Hostnames',
  env_var: 'Env vars',
  uuid: 'UUIDs',
  systemd_unit: 'Services',
  mac_address: 'MAC addresses',
};

export function wrappedEntityMemoryRows(kinds: WrappedStats['entities']['memoryKinds']) {
  return kinds.map(({ kind, n }) => ({ label: ENTITY_LABELS[kind], n }));
}

export function wrappedEntityRows(kinds: WrappedStats['entities']['kinds']) {
  const rows = kinds.slice(0, 4).map(({ kind, n }) => ({ label: ENTITY_LABELS[kind], n }));
  const other = kinds.slice(4).reduce((sum, row) => sum + row.n, 0);
  if (other > 0) rows.push({ label: 'Other', n: other });
  return rows;
}

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
  const heroHeight = story ? 630 : 350;
  const metricY = story ? 1150 : 710;
  const activityY = story ? 1340 : 814;
  const summaryY = story ? 1660 : 944;
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

  const entityRows = wrappedEntityRows(data.entities.kinds);
  const mixY = story ? 970 : 568;
  const mixTotal = Math.max(1, data.entities.total);
  let mixX = 96;
  entityRows.forEach((row, i) => {
    const segmentWidth = (888 * row.n) / mixTotal;
    panel(
      mixX,
      mixY + 14,
      segmentWidth,
      10,
      i === 0 ? '#c6f24e' : ['#a1a1aa', '#71717a', '#52525b', '#3f3f46'][i - 1]!,
    );
    text(`${row.label} ${formatWrappedCount(row.n)}`, 96 + i * 180, mixY, 16, '#a1a1aa', mono, 168);
    mixX += segmentWidth;
  });
  if (entityRows.length === 0) text('No indexed entities yet', 96, mixY, 18, '#a1a1aa', mono);
  if (data.entities.scannedMemories < data.entities.eligibleMemories)
    text(
      `Partial index · ${formatWrappedCount(data.entities.scannedMemories)} / ${formatWrappedCount(data.entities.eligibleMemories)} project memories scanned`,
      96,
      mixY + 48,
      16,
      '#a1a1aa',
      mono,
      888,
    );

  const metrics = [
    [data.sessions, 'sessions'],
    [data.judgments, 'judgments'],
    [data.projects, 'active projects'],
    [data.entities.total, 'entities'],
  ] as const;
  metrics.forEach(([n, label], i) => {
    const x = 96 + i * 228;
    text(formatWrappedCount(n), x, metricY, story ? 86 : 64, '#fafafa', sans, 204);
    text(label, x, metricY + (story ? 40 : 30), story ? 21 : 17, '#a1a1aa', mono, 204);
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
      summaryY + (story ? 174 : 86),
      20,
      '#c6f24e',
      mono,
      350,
    );
  text('Monthly saves', 540, summaryY, 21, '#a1a1aa', mono, 444);
  const baseline = summaryY + (story ? 150 : 62);
  const peak = Math.max(1, ...data.months);
  data.months.forEach((n, i) => {
    const barHeight = Math.max(3, (n / peak) * (story ? 112 : 36));
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
