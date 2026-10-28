import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from './cn';

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  title?: string;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: SegmentOption<T>[];
  label: string;
  size?: 'sm' | 'md';
  fullWidth?: boolean;
  className?: string;
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  label,
  size = 'md',
  fullWidth,
  className,
}: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const dir = event.key === 'ArrowRight' ? 1 : -1;
    for (let step = 1; step <= options.length; step++) {
      const next = (index + dir * step + options.length) % options.length;
      if (!options[next].disabled) {
        onChange(options[next].value);
        refs.current[next]?.focus();
        break;
      }
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-full border border-line bg-surface-1 p-1',
        fullWidth && 'flex w-full',
        className
      )}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={option.disabled}
            title={option.title}
            onClick={() => onChange(option.value)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={cn(
              'inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-medium whitespace-nowrap transition-colors duration-150',
              size === 'md' ? 'h-9 px-4 text-[13px]' : 'h-7 px-3 text-xs',
              fullWidth && 'flex-1',
              selected ? 'bg-surface-4 text-ink shadow-[inset_0_0_0_1px_var(--color-line-strong)]' : 'text-ink-3 hover:text-ink',
              option.disabled && 'cursor-not-allowed opacity-40 hover:text-ink-3'
            )}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
