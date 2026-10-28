import type { ReactNode } from 'react';
import { cn } from './cn';
import { Spinner } from './Button';

interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}

export function EmptyState({ icon, title, description, action, className, compact }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-[18px] border border-dashed border-line-strong text-center',
        compact ? 'gap-3 px-6 py-10' : 'gap-4 px-8 py-16',
        className
      )}
    >
      {icon && (
        <div className="flex size-12 items-center justify-center rounded-[14px] border border-line-strong bg-surface-2 text-ink-2">
          {icon}
        </div>
      )}
      <div className="max-w-sm">
        <p className="text-[15px] font-medium text-ink">{title}</p>
        {description && <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-3">{description}</p>}
      </div>
      {action && <div className="mt-1 flex flex-wrap items-center justify-center gap-3">{action}</div>}
    </div>
  );
}

export function LoadingState({ label = 'Loading…', className }: { label?: string; className?: string }) {
  return (
    <div className={cn('flex h-full min-h-48 flex-col items-center justify-center gap-3 text-ink-3', className)}>
      <Spinner size={20} />
      <p className="text-[13px]">{label}</p>
    </div>
  );
}

/** Skeleton block for card grids while data loads. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-[18px] bg-surface-2', className)} />;
}
