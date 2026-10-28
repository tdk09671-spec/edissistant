import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';

type Variant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const variants: Record<Variant, string> = {
  primary: 'bg-ink text-canvas hover:bg-white active:bg-ink-2 disabled:bg-surface-4 disabled:text-ink-4',
  accent: 'bg-signal text-signal-ink hover:bg-signal-strong disabled:bg-surface-4 disabled:text-ink-4',
  secondary:
    'bg-surface-3 text-ink border border-line-strong hover:bg-surface-4 hover:border-ink-4 disabled:text-ink-4 disabled:hover:bg-surface-3 disabled:hover:border-line-strong',
  ghost: 'text-ink-2 hover:text-ink hover:bg-surface-3 disabled:text-ink-4 disabled:hover:bg-transparent',
  danger: 'bg-danger/12 text-danger border border-danger/30 hover:bg-danger hover:text-canvas disabled:opacity-50',
};

const sizes: Record<Size, string> = {
  sm: 'h-9 px-3.5 text-[13px] gap-1.5',
  md: 'h-11 px-5 text-sm gap-2',
  lg: 'h-12 px-6 text-[15px] gap-2.5',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  iconRight?: ReactNode;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, iconRight, loading, className, children, disabled, type = 'button', ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-medium tracking-[-0.005em] whitespace-nowrap',
        'transition-[background-color,color,border-color,transform] duration-150 active:scale-[0.98] disabled:active:scale-100',
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    >
      {loading ? <Spinner /> : icon}
      {children}
      {iconRight}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'ghost' | 'secondary' | 'danger';
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'md', variant = 'ghost', active, className, children, type = 'button', ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[10px] transition-colors duration-150',
        size === 'sm' && 'size-8',
        size === 'md' && 'size-10',
        size === 'lg' && 'size-11',
        variant === 'ghost' && 'text-ink-3 hover:text-ink hover:bg-surface-3',
        variant === 'secondary' && 'text-ink-2 bg-surface-3 border border-line-strong hover:text-ink hover:bg-surface-4',
        variant === 'danger' && 'text-ink-3 hover:text-danger hover:bg-danger/10',
        active && 'text-ink bg-surface-4',
        'disabled:text-ink-4 disabled:hover:bg-transparent',
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
});

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn('inline-block shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent opacity-70', className)}
      style={{ width: size, height: size }}
    />
  );
}
