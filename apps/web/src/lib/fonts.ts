import localFont from 'next/font/local';

/**
 * `next/font/local`'s return type is declared in Next's `dist/compiled` tree,
 * which is not a public export path, so letting TypeScript infer the type makes
 * the declaration non-portable (TS2742) and naming it explicitly would reach
 * into internals. Only these two public fields are consumed here.
 */
type LocalFontHandle = { readonly className: string; readonly variable: string };

// The brand faces are vendored, self-hosted and consumed through
// `next/font/local` so the build content-hashes them, preloads them and drops
// the `@font-face` + immutable-cache header pair the retired dashboard had to
// maintain by hand (see the change's D5 decision).
//
// The `src` paths are resolved relative to this file, which is why the loader
// lives in `src/lib` and the bytes in `src/app/fonts`.

export const fontDisplay: LocalFontHandle = localFont({
  src: [
    { path: '../app/fonts/space-grotesk-400.woff2', weight: '400', style: 'normal' },
    { path: '../app/fonts/space-grotesk-500.woff2', weight: '500', style: 'normal' },
    { path: '../app/fonts/space-grotesk-600.woff2', weight: '600', style: 'normal' },
    { path: '../app/fonts/space-grotesk-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-grotesk',
  display: 'swap',
  fallback: ['system-ui', 'sans-serif'],
});

export const fontSans: LocalFontHandle = localFont({
  src: [
    { path: '../app/fonts/inter-400.woff2', weight: '400', style: 'normal' },
    { path: '../app/fonts/inter-500.woff2', weight: '500', style: 'normal' },
    { path: '../app/fonts/inter-600.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-inter',
  display: 'swap',
  fallback: ['system-ui', 'sans-serif'],
});

export const fontMono: LocalFontHandle = localFont({
  src: [
    { path: '../app/fonts/jetbrains-mono-400.woff2', weight: '400', style: 'normal' },
    { path: '../app/fonts/jetbrains-mono-500.woff2', weight: '500', style: 'normal' },
    { path: '../app/fonts/jetbrains-mono-600.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-jetbrains',
  display: 'swap',
  fallback: ['ui-monospace', 'monospace'],
});
