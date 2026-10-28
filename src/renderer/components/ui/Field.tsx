import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from './cn';
import { IconChevronDown } from './icons';

const controlBase =
  'w-full rounded-[10px] border bg-surface-1 text-ink placeholder:text-ink-4 transition-[border-color,box-shadow,background-color] duration-150 ' +
  'hover:border-ink-4 focus:border-signal focus:shadow-[0_0_0_3px_rgb(233_169_75/0.18)] focus-visible:outline-none ' +
  'disabled:cursor-not-allowed disabled:text-ink-3 disabled:hover:border-line-strong';

function borderFor(invalid?: boolean) {
  return invalid ? 'border-danger/70' : 'border-line-strong';
}

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  required?: boolean;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
  action?: ReactNode;
}

/** Label + control + hint/error, with consistent vertical rhythm. */
export function Field({ label, hint, error, optional, required, htmlFor, className, children, action }: FieldProps) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {(label || action) && (
        <div className="flex min-h-5 items-end justify-between gap-3">
          {label && (
            <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink-2">
              {label}
              {required && <span className="ml-1 text-signal">*</span>}
              {optional && <span className="ml-2 font-normal text-ink-3">Optional</span>}
            </label>
          )}
          {action}
        </div>
      )}
      {children}
      {error ? (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[13px] leading-relaxed text-ink-3">{hint}</p>
      ) : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  inputSize?: 'sm' | 'md';
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, leading, trailing, className, inputSize = 'md', ...props },
  ref
) {
  const generatedId = useId();
  const input = (
    <input
      ref={ref}
      id={props.id ?? generatedId}
      aria-invalid={invalid || undefined}
      className={cn(
        controlBase,
        borderFor(invalid),
        inputSize === 'md' ? 'h-11 px-3.5 text-sm' : 'h-9 px-3 text-[13px]',
        leading && 'pl-10',
        trailing && 'pr-10',
        !leading && !trailing && className
      )}
      {...props}
    />
  );
  if (!leading && !trailing) return input;
  return (
    <div className={cn('relative', className)}>
      {leading && (
        <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-ink-3">{leading}</span>
      )}
      {input}
      {trailing && <span className="absolute inset-y-0 right-2 flex items-center">{trailing}</span>}
    </div>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, className, rows = 4, ...props },
  ref
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cn(controlBase, borderFor(invalid), 'min-h-24 resize-y px-3.5 py-3 text-sm leading-relaxed', className)}
      {...props}
    />
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
  selectSize?: 'sm' | 'md';
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { invalid, className, children, selectSize = 'md', ...props },
  ref
) {
  return (
    <div className={cn('relative', className)}>
      <select
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          controlBase,
          borderFor(invalid),
          'appearance-none pr-10',
          selectSize === 'md' ? 'h-11 pl-3.5 text-sm' : 'h-9 pl-3 text-[13px]'
        )}
        {...props}
      >
        {children}
      </select>
      <IconChevronDown size={16} className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-3" />
    </div>
  );
});

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  id?: string;
}

export function Toggle({ checked, onChange, label, disabled, id }: ToggleProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors duration-150 disabled:opacity-40',
        checked ? 'border-signal bg-signal' : 'border-line-strong bg-surface-3 hover:border-ink-4'
      )}
    >
      <span
        className={cn(
          'absolute size-5 rounded-full shadow-sm transition-[left,background-color] duration-150',
          checked ? 'left-[23px] bg-signal-ink' : 'left-[3px] bg-ink-2'
        )}
      />
    </button>
  );
}

/** Settings-style row: label and description on the left, control on the right. */
export function SettingRow({
  title,
  description,
  children,
  htmlFor,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 py-5 first:pt-0 last:pb-0">
      <div className="min-w-0 max-w-xl flex-1">
        <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">
          {title}
        </label>
        {description && <p className="mt-1 text-[13px] leading-relaxed text-ink-3">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
