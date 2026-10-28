import { useEffect, useState } from 'react';
import { useData } from '../state/DataProvider';
import { IconAlert, IconClose, IconMaximize, IconMinimize, IconRestore } from './ui/icons';
import { Tooltip } from './ui';

export default function TitleBar() {
  const api = window.electronAPI;
  const { saveError } = useData();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!api?.onMaximizedChange) return;
    api.isMaximized?.().then(setMaximized).catch(() => undefined);
    return api.onMaximizedChange(setMaximized);
  }, [api]);

  const controlClass =
    'titlebar-no-drag flex h-10 w-12 items-center justify-center text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink focus-visible:outline-offset-[-2px]';

  return (
    <div className="titlebar-drag flex h-10 shrink-0 items-center justify-between border-b border-line bg-surface-1 pl-4 select-none">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="text-[12.5px] font-semibold tracking-[0.14em] text-ink-2 uppercase">Edissistant</span>
        <span className="timecode rounded-full border border-line-strong px-2 py-px text-xs text-ink-3">v0.1</span>
      </div>
      <div className="flex items-center">
        {saveError && (
          <Tooltip content={`Changes could not be written to disk: ${saveError}`} placement="bottom">
            <span tabIndex={0} className="titlebar-no-drag mr-3 flex items-center gap-1.5 text-[12.5px] text-danger">
              <IconAlert size={14} /> Save failed
            </span>
          </Tooltip>
        )}
        {api && (
          <>
            <button type="button" aria-label="Minimize" onClick={() => api.minimize()} className={controlClass}>
              <IconMinimize size={15} />
            </button>
            <button type="button" aria-label={maximized ? 'Restore' : 'Maximize'} onClick={() => api.maximize()} className={controlClass}>
              {maximized ? <IconRestore size={14} /> : <IconMaximize size={13} />}
            </button>
            <button
              type="button"
              aria-label="Close"
              onClick={() => api.close()}
              className="titlebar-no-drag flex h-10 w-12 items-center justify-center text-ink-3 transition-colors hover:bg-[#c42b1c] hover:text-white focus-visible:outline-offset-[-2px]"
            >
              <IconClose size={15} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
