import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padding?: 'none' | 'sm' | 'md' | 'lg';
  interactive?: boolean;
}

export function Card({ padding = 'md', interactive, className, children, ...props }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-[18px] border border-line bg-surface-2 shadow-[var(--shadow-card)]',
        padding === 'sm' && 'p-5',
        padding === 'md' && 'p-6',
        padding === 'lg' && 'p-8',
        interactive && 'transition-[border-color,background-color] duration-150 hover:border-line-strong hover:bg-[#191a20]',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

type Tone = 'neutral' | 'signal' | 'success' | 'warning' | 'danger' | 'info' | 'outline';

const tones: Record<Tone, string> = {
  neutral: 'bg-surface-4 text-ink-2',
  signal: 'bg-signal-soft text-signal',
  success: 'bg-success/12 text-success',
  warning: 'bg-warning/12 text-warning',
  danger: 'bg-danger/12 text-danger',
  info: 'bg-info/12 text-info',
  outline: 'border border-line-strong text-ink-3',
};

export function Badge({ tone = 'neutral', children, dot, className }: { tone?: Tone; children: ReactNode; dot?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap',
        tones[tone],
        className
      )}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

/** Marks controls that depend on services not yet integrated (rendering, AI). */
export function UnavailableBadge({ children = 'Not yet available' }: { children?: ReactNode }) {
  return <Badge tone="outline">{children}</Badge>;
}

/** Callout used to explain an unavailable or informational state in context. */
export function Notice({
  tone = 'neutral',
  icon,
  title,
  children,
  className,
  action,
}: {
  tone?: 'neutral' | 'signal' | 'danger' | 'success';
  icon?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex gap-3.5 rounded-[14px] border p-4',
        tone === 'neutral' && 'border-line bg-surface-1',
        tone === 'signal' && 'border-signal/25 bg-signal-soft',
        tone === 'danger' && 'border-danger/30 bg-danger/8',
        tone === 'success' && 'border-success/30 bg-success/8',
        className
      )}
    >
      {icon && (
        <span
          className={cn(
            'mt-0.5 shrink-0',
            tone === 'neutral' && 'text-ink-3',
            tone === 'signal' && 'text-signal',
            tone === 'danger' && 'text-danger',
            tone === 'success' && 'text-success'
          )}
        >
          {icon}
        </span>
      )}
      <div className="min-w-0 flex-1">
        {title && <p className="text-sm font-medium text-ink">{title}</p>}
        {children && <div className={cn('text-[13px] leading-relaxed text-ink-2', title && 'mt-1')}>{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}
