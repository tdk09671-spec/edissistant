import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';
import { IconAlert, IconCheckCircle, IconClose, IconInfo } from './icons';

type ToastTone = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

interface ToastContextValue {
  toast: (title: string, options?: { tone?: ToastTone; description?: string }) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);

  const toast = useCallback<ToastContextValue['toast']>(
    (title, options) => {
      const id = nextId.current++;
      setItems((all) => [...all.slice(-3), { id, title, tone: options?.tone ?? 'success', description: options?.description }]);
      window.setTimeout(() => dismiss(id), options?.tone === 'error' ? 6000 : 3500);
    },
    [dismiss]
  );

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div aria-live="polite" className="pointer-events-none fixed right-6 bottom-6 z-[300] flex w-[360px] max-w-[calc(100vw-48px)] flex-col gap-2.5">
          {items.map((item) => (
            <div
              key={item.id}
              role={item.tone === 'error' ? 'alert' : 'status'}
              className="pointer-events-auto flex animate-slide-up items-start gap-3 rounded-[14px] border border-line-strong bg-surface-3 p-4 shadow-[var(--shadow-pop)]"
            >
              <span
                className={cn(
                  'mt-0.5 shrink-0',
                  item.tone === 'success' && 'text-success',
                  item.tone === 'error' && 'text-danger',
                  item.tone === 'info' && 'text-info'
                )}
              >
                {item.tone === 'success' ? <IconCheckCircle size={18} /> : item.tone === 'error' ? <IconAlert size={18} /> : <IconInfo size={18} />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">{item.title}</p>
                {item.description && <p className="mt-0.5 text-[13px] leading-relaxed break-words text-ink-2">{item.description}</p>}
              </div>
              <button
                type="button"
                aria-label="Dismiss notification"
                onClick={() => dismiss(item.id)}
                className="-mt-1 -mr-1 flex size-7 shrink-0 items-center justify-center rounded-[8px] text-ink-3 hover:bg-surface-4 hover:text-ink"
              >
                <IconClose size={14} />
              </button>
            </div>
          ))}
        </div>,
        document.body
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx.toast;
}
