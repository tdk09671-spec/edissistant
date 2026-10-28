import { cn } from './cn';
import { IconCheck } from './icons';

export interface Step {
  title: string;
  description?: string;
}

interface StepIndicatorProps {
  steps: Step[];
  current: number;
  /** Highest step index the user may jump to */
  maxReachable: number;
  onSelect: (index: number) => void;
}

/** Numbered steps (01, 02 …) in the Ommi editorial style. Completed steps are clickable. */
export function StepIndicator({ steps, current, maxReachable, onSelect }: StepIndicatorProps) {
  return (
    <ol className="grid gap-2" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
      {steps.map((step, index) => {
        const done = index < current;
        const active = index === current;
        const reachable = index <= maxReachable;
        return (
          <li key={step.title} className="min-w-0">
            <button
              type="button"
              disabled={!reachable}
              onClick={() => onSelect(index)}
              aria-current={active ? 'step' : undefined}
              className={cn(
                'group flex w-full min-w-0 flex-col gap-3 rounded-[10px] pt-0 pb-2 text-left transition-colors',
                !reachable && 'cursor-default'
              )}
            >
              <span
                className={cn(
                  'h-[3px] w-full rounded-full transition-colors duration-200',
                  active ? 'bg-signal' : done ? 'bg-ink-2' : 'bg-surface-4'
                )}
              />
              <span className="flex min-w-0 items-center gap-2.5">
                <span
                  className={cn(
                    'timecode flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium',
                    active && 'bg-signal text-signal-ink',
                    done && 'bg-ink-2 text-canvas',
                    !active && !done && 'border border-line-strong text-ink-3'
                  )}
                >
                  {done ? <IconCheck size={13} strokeWidth={2.4} /> : String(index + 1).padStart(2, '0')}
                </span>
                <span
                  className={cn(
                    'truncate text-[13px] font-medium',
                    active ? 'text-ink' : reachable ? 'text-ink-2 group-hover:text-ink' : 'text-ink-3'
                  )}
                >
                  {step.title}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
