import type { Metadata } from 'next';
import { IBM_Plex_Mono, Instrument_Sans, Instrument_Serif } from 'next/font/google';
import type { ReactNode } from 'react';

import './globals.css';
import { Nav } from './components/Nav';

const sans = Instrument_Sans({
  subsets: ['latin'],
  variable: '--font-app-sans',
  display: 'swap',
});

const display = Instrument_Serif({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-app-display',
  display: 'swap',
});

const mono = IBM_Plex_Mono({
  weight: ['400', '500', '600'],
  subsets: ['latin'],
  variable: '--font-app-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Sequencer — Revenue recovery control',
  description:
    'Reason-aware recovery for recurring payments. Diagnose the failure, protect the attempt budget, and keep every decision auditable.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable} ${mono.variable}`}>
      <body className="flex min-h-screen flex-col">
        <Nav />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 pt-8 pb-20 sm:px-6 sm:pt-10 lg:px-8">
          {children}
        </main>
        <footer className="border-line border-t">
          <div className="text-ink-faint mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-5 text-[10px] sm:px-6 lg:px-8">
            <p className="flex items-center gap-2">
              <span className="bg-brand inline-block h-1.5 w-1.5 rounded-full" aria-hidden />
              Sequencer — reason-aware recovery for recurring payments
            </p>
            <p>
              Built for the Razorpay AI Buildathon, Track 03 · measured on simulated cohorts ·{' '}
              <a
                href="https://github.com/AryanTandon2019/sequencer"
                target="_blank"
                rel="noopener noreferrer"
                className="text-ink-soft hover:text-ink"
              >
                source &amp; method
              </a>
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
