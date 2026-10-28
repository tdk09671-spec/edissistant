import {
  cloneElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';

type Placement = 'top' | 'bottom' | 'bottom-end' | 'bottom-start';

function computePosition(anchor: DOMRect, floating: DOMRect, placement: Placement) {
  const gap = 8;
  const margin = 8;
  let top = placement === 'top' ? anchor.top - floating.height - gap : anchor.bottom + gap;
  let left =
    placement === 'bottom-end'
      ? anchor.right - floating.width
      : placement === 'bottom-start'
        ? anchor.left
        : anchor.left + anchor.width / 2 - floating.width / 2;

  // Flip vertically when there is no room, then clamp inside the window.
  if (placement !== 'top' && top + floating.height > window.innerHeight - margin) {
    top = anchor.top - floating.height - gap;
  }
  if (placement === 'top' && top < margin) top = anchor.bottom + gap;
  left = Math.max(margin, Math.min(left, window.innerWidth - floating.width - margin));
  top = Math.max(margin, Math.min(top, window.innerHeight - floating.height - margin));
  return { top, left };
}

interface TooltipProps {
  content: ReactNode;
  children: ReactElement<Record<string, unknown>>;
  placement?: 'top' | 'bottom';
}

/** Hover/focus tooltip rendered in a portal so it is never clipped by scrolling panels. */
export function Tooltip({ content, children, placement = 'top' }: TooltipProps) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);

  const show = (el: HTMLElement) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setAnchor(el.getBoundingClientRect()), 350);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setAnchor(null);
    setPos(null);
  };

  useLayoutEffect(() => {
    if (anchor && tipRef.current) setPos(computePosition(anchor, tipRef.current.getBoundingClientRect(), placement));
  }, [anchor, placement]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const props = children.props as Record<string, (e: unknown) => void>;
  const trigger = cloneElement(children, {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      props.onMouseEnter?.(e);
      show(e.currentTarget);
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      props.onMouseLeave?.(e);
      hide();
    },
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      props.onFocus?.(e);
      if (e.currentTarget.matches(':focus-visible')) show(e.currentTarget);
    },
    onBlur: (e: React.FocusEvent<HTMLElement>) => {
      props.onBlur?.(e);
      hide();
    },
  });

  return (
    <>
      {trigger}
      {anchor &&
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            className="pointer-events-none fixed z-[200] max-w-[280px] rounded-[8px] border border-line-strong bg-surface-4 px-3 py-2 text-[12.5px] leading-snug text-ink shadow-[var(--shadow-pop)]"
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
          >
            {content}
          </div>,
          document.body
        )}
    </>
  );
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface MenuProps {
  trigger: (props: { onClick: (e: React.MouseEvent<HTMLElement>) => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => ReactNode;
  items: Array<MenuItem | 'divider'>;
  placement?: 'bottom-end' | 'bottom-start';
}

/** Lightweight dropdown menu with keyboard navigation. */
export function Menu({ trigger, items, placement = 'bottom-end' }: MenuProps) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerEl = useRef<HTMLElement | null>(null);

  const close = useCallback((restoreFocus = true) => {
    setAnchor(null);
    setPos(null);
    if (restoreFocus) triggerEl.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (anchor && menuRef.current) {
      setPos(computePosition(anchor, menuRef.current.getBoundingClientRect(), placement));
      menuRef.current.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    }
  }, [anchor, placement]);

  useEffect(() => {
    if (!anchor) return;
    const onPointer = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !triggerEl.current?.contains(event.target as Node)) close(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    const onScroll = () => close(false);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [anchor, close]);

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nodes = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
    const index = nodes.indexOf(document.activeElement as HTMLElement);
    let next = 0;
    if (event.key === 'ArrowDown') next = (index + 1) % nodes.length;
    if (event.key === 'ArrowUp') next = (index - 1 + nodes.length) % nodes.length;
    if (event.key === 'End') next = nodes.length - 1;
    nodes[next]?.focus();
  };

  return (
    <>
      {trigger({
        onClick: (e) => {
          e.stopPropagation();
          triggerEl.current = e.currentTarget;
          if (anchor) close(false);
          else setAnchor(e.currentTarget.getBoundingClientRect());
        },
        'aria-expanded': Boolean(anchor),
        'aria-haspopup': 'menu',
      })}
      {anchor &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            onKeyDown={onMenuKeyDown}
            className="fixed z-[150] min-w-[200px] animate-pop-in rounded-[12px] border border-line-strong bg-surface-3 p-1.5 shadow-[var(--shadow-pop)]"
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
          >
            {items.map((item, i) =>
              item === 'divider' ? (
                <div key={`d${i}`} className="my-1.5 h-px bg-line-strong" />
              ) : (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    close(false);
                    item.onSelect();
                  }}
                  className={cn(
                    'flex h-10 w-full items-center gap-3 rounded-[8px] px-3 text-left text-[13.5px] transition-colors focus-visible:outline-none',
                    item.danger
                      ? 'text-danger hover:bg-danger/12 focus:bg-danger/12'
                      : 'text-ink-2 hover:bg-surface-4 hover:text-ink focus:bg-surface-4 focus:text-ink',
                    'disabled:pointer-events-none disabled:opacity-40'
                  )}
                >
                  {item.icon && <span className="shrink-0 opacity-80">{item.icon}</span>}
                  {item.label}
                </button>
              )
            )}
          </div>,
          document.body
        )}
    </>
  );
}
