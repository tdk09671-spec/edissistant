import type { ReactNode } from 'react';
import { cn } from './cn';

interface PageHeaderProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  size?: 'display' | 'title';
  className?: string;
}

export function PageHeader({ eyebrow, title, description, actions, size = 'title', className }: PageHeaderProps) {
  return (
    <header className={cn('flex flex-wrap items-end justify-between gap-x-8 gap-y-5', className)}>
      <div className="min-w-0 max-w-3xl">
        {eyebrow && <p className="eyebrow mb-3">{eyebrow}</p>}
        <h1 className={cn('font-semibold text-ink', size === 'display' ? 'text-display' : 'text-title')}>{title}</h1>
        {description && <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-3">{actions}</div>}
    </header>
  );
}

interface SectionHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  count?: number;
  className?: string;
  as?: 'h2' | 'h3';
}

export function SectionHeader({ title, description, action, count, className, as: Tag = 'h2' }: SectionHeaderProps) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-x-6 gap-y-3', className)}>
      <div className="min-w-0">
        <Tag className="flex items-center gap-2.5 text-[17px] font-semibold tracking-[-0.015em] text-ink">
          {title}
          {count !== undefined && <span className="timecode text-[13px] font-normal text-ink-3">{count}</span>}
        </Tag>
        {description && <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}
