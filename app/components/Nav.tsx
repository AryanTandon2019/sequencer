'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Mark } from './Primitives';

const LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/cases', label: 'Recoveries' },
  { href: '/playground', label: 'Playground' },
] as const;

function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

export function Nav() {
  const pathname = usePathname() ?? '/';

  return (
    <header className="border-line sticky top-0 z-40 border-b bg-white/92 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:gap-8 sm:px-6 lg:px-8">
        <Link href="/" className="flex shrink-0 items-center gap-2.5" aria-label="Sequencer dashboard">
          <span className="border-line bg-surface flex h-8 w-8 items-center justify-center rounded-lg border shadow-[0_1px_2px_rgb(15_23_42/0.06)]">
            <Mark className="w-4" />
          </span>
          <span className="text-ink hidden text-sm font-semibold tracking-tight sm:inline">Sequencer</span>
        </Link>

        <nav className="flex h-full items-center gap-4 sm:gap-6" aria-label="Primary navigation">
          {LINKS.map((link) => {
            const active = isActive(pathname, link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className={`relative flex h-full items-center text-[13px] font-medium transition-colors ${
                  active
                    ? 'text-ink after:bg-brand after:absolute after:inset-x-0 after:bottom-0 after:h-0.5'
                    : 'text-ink-faint hover:text-ink'
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <span className="text-ink-faint hidden items-center gap-2 text-[11px] lg:flex">
            <span className="bg-permitted h-1.5 w-1.5 rounded-full" />
            Validated simulation
          </span>
          <a
            href="https://github.com/AryanTandon2019/sequencer"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-ghost h-9 min-h-9 w-9 px-0 sm:w-auto sm:px-3"
            aria-label="View Sequencer source code on GitHub (opens in a new tab)"
          >
            <GitHubIcon />
            <span className="hidden lg:inline">GitHub</span>
          </a>
          <Link href="/#live-run" className="btn btn-primary hidden sm:inline-flex">
            Run demo
          </Link>
        </div>
      </div>
    </header>
  );
}

function GitHubIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="currentColor"
    >
      <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2.23c-3.23.7-3.91-1.37-3.91-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.17.08 1.78 1.2 1.78 1.2 1.04 1.78 2.72 1.27 3.38.97.1-.75.41-1.27.74-1.56-2.58-.29-5.29-1.29-5.29-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.47.11-3.05 0 0 .97-.31 3.16 1.18A10.96 10.96 0 0 1 12 6.12c.98 0 1.95.13 2.87.39 2.2-1.49 3.16-1.18 3.16-1.18.63 1.58.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.4-2.72 5.38-5.31 5.67.42.36.79 1.06.79 2.15v3.26c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" />
    </svg>
  );
}
