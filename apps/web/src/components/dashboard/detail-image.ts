import { getFontEmbedCSS, toBlob } from 'html-to-image';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import { DetailImageCard } from './detail-image-card';

export type DetailShareData = {
  kind: string;
  label: string;
  title: string;
  date: Date;
  byline: string;
  projectName: string;
  content: { text: string; mode: 'markdown' | 'literal'; label: string };
  tags?: string[];
  duration?: string;
  stats?: { label: string; value: string }[];
};
export type DetailImageOptions = { content: boolean; project: boolean; stats: boolean };
export const DETAIL_IMAGE_DEFAULTS: DetailImageOptions = {
  content: true,
  project: true,
  stats: true,
};
export type DetailImage = { blob: Blob; width: number; height: number };
const WIDTH = 1080;
const MAX_HEIGHT = Math.floor(16_000_000 / WIDTH);

export async function createDetailImage(
  data: DetailShareData,
  options: Partial<DetailImageOptions> = {},
): Promise<DetailImage> {
  const settings = { ...DETAIL_IMAGE_DEFAULTS, ...options };
  const styles = getComputedStyle(document.documentElement);
  const sans = styles.getPropertyValue('--font-geist').trim();
  const mono = styles.getPropertyValue('--font-geist-mono').trim();
  if (!sans || !mono) throw new Error('The local Geist fonts are not ready. Please retry.');
  const fonts = [`400 34px ${sans}`, `600 76px ${sans}`, `400 26px ${mono}`, `600 28px ${mono}`];
  const loaded = await Promise.all(fonts.map((font) => document.fonts.load(font)));
  await document.fonts.ready;
  if (
    loaded.some((faces) => faces.length === 0) ||
    fonts.some((font) => !document.fonts.check(font))
  )
    throw new Error('The local Geist fonts could not be loaded. Please retry.');
  const response = await fetch('/dashboard/assets/logo-transparent.png', {
    mode: 'same-origin',
    credentials: 'same-origin',
  });
  if (!response.ok) throw new Error('The local Rembric logo could not be loaded. Please retry.');
  const logoBlob = await response.blob();
  if (logoBlob.type !== 'image/png') throw new Error('The local Rembric logo is not a PNG.');
  const logo = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('Could not prepare the local logo.'));
    reader.onerror = () => reject(new Error('Could not prepare the local logo.'));
    reader.readAsDataURL(logoBlob);
  });
  const host = document.createElement('div');
  host.className = 'detail-image-stage pointer-events-none fixed top-0 -left-[100000px] w-[1080px]';
  host.setAttribute('aria-hidden', 'true');
  host.inert = true;
  document.body.append(host);
  let renderError: unknown;
  const root = createRoot(host, {
    onUncaughtError: (cause) => {
      renderError = cause;
    },
  });
  try {
    flushSync(() => root.render(createElement(DetailImageCard, { data, options: settings, logo })));
    if (renderError)
      throw renderError instanceof Error
        ? renderError
        : new Error('The image card could not be rendered.');
    const card = host.firstElementChild;
    if (!(card instanceof HTMLElement)) throw new Error('The image card could not be rendered.');
    await Promise.all(Array.from(card.querySelectorAll('img'), (image) => image.decode()));
    const width = card.offsetWidth;
    const height = Math.ceil(card.getBoundingClientRect().height);
    if (width !== WIDTH || height < 1080)
      throw new Error('The PNG layout is not ready. Please retry.');
    if (height > MAX_HEIGHT)
      throw new Error(
        'This content is too tall for a safe PNG export (16 megapixel limit). Turn off full content or export a shorter selection. Nothing was truncated.',
      );
    for (const element of [card, ...card.querySelectorAll<HTMLElement>('*')]) {
      if (element.clientWidth && element.scrollWidth > element.clientWidth + 1)
        throw new Error('This content exceeds the PNG layout width. Nothing was truncated.');
    }
    const fontEmbedCSS = await getFontEmbedCSS(card, {
      preferredFontFormat: 'woff2',
      fetchRequestInit: { mode: 'same-origin', credentials: 'same-origin' },
    });
    if (!fontEmbedCSS.includes('data:') || /url\(\s*["']?(?!data:)[^"')]+\)/i.test(fontEmbedCSS))
      throw new Error('The local Geist fonts could not be embedded. Please retry.');
    const blob = await toBlob(card, {
      width,
      height,
      pixelRatio: 1,
      skipAutoScale: true,
      fontEmbedCSS,
      backgroundColor: '#09090b',
      fetchRequestInit: { mode: 'same-origin', credentials: 'same-origin' },
    });
    if (!blob || blob.type !== 'image/png') throw new Error('PNG encoding failed. Please retry.');
    return { blob, width, height };
  } finally {
    root.unmount();
    host.remove();
  }
}
