import type { ReactNode } from 'react';

import { TONE_CLASS, type Tone } from '../lib/format';

export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={`panel ${className}`}>{children}</section>;
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap ${TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}

export function Empty({ title, hint }: { title: string; hint: ReactNode }) {
  return (
    <Card className="mx-auto max-w-lg p-8 text-center">
      <h2 className="text-ink text-base font-medium">{title}</h2>
      <p className="text-ink-soft mx-auto mt-2 text-sm leading-relaxed">{hint}</p>
    </Card>
  );
}

/** Four slots. The whole product, in one glyph. */
export function AttemptMeter({
  used,
  recovered,
  size = 'md',
}: {
  used: number;
  recovered: boolean;
  size?: 'sm' | 'md' | 'lg';
}) {
  const filled = Math.min(used, 4);
  const height = size === 'lg' ? 'h-2' : size === 'sm' ? 'h-1' : 'h-1.5';
  return (
    <span
      className={`inline-flex w-16 items-center gap-0.5 ${size === 'lg' ? 'w-24' : ''}`}
      title={`${used} of 4 attempts used`}
    >
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className={`${height} flex-1 rounded-[1px] ${
            i < filled ? (recovered ? 'bg-permitted' : 'bg-refused') : 'bg-line-strong'
          }`}
        />
      ))}
    </span>
  );
}

export function Mark({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex w-7 items-center gap-px ${className}`} aria-hidden>
      <span className="bg-brand h-2 flex-1 rounded-[1px]" />
      <span className="bg-brand h-2 flex-1 rounded-[1px]" />
      <span className="bg-brand/65 h-2 flex-1 rounded-[1px]" />
      <span className="bg-line-strong h-2 flex-1 rounded-[1px]" />
    </span>
  );
}
