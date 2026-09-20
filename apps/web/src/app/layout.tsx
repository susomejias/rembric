import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { fontDisplay, fontMono, fontSans } from '@/lib/fonts';

import './globals.css';

export const metadata: Metadata = {
  title: 'Rembric',
};

// The document carries no theme class by default: `:root` holds the light
// values and `.dark` opts into the near-black set. Adding `class="dark"` here
// would make the light branch unreachable in the shipped application.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${fontSans.variable} ${fontDisplay.variable} ${fontMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
