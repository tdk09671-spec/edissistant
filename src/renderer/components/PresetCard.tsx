import type { ReactNode } from 'react';
import type { Preset } from '../types';
import { presetTypeInfo } from '../lib/catalog';
import { formatRelative } from '../lib/time';
import { Badge, IconButton, Menu, type MenuItem } from './ui';
import { IconFilm, IconLink, IconMore, IconType } from './ui/icons';

interface PresetCardProps {
  preset: Preset;
  onOpen: () => void;
  menuItems?: Array<MenuItem | 'divider'>;
  footer?: ReactNode;
}

export function PresetCard({ preset, onOpen, menuItems, footer }: PresetCardProps) {
  const type = presetTypeInfo(preset.type);
  const refCount = preset.referenceLinks.filter(Boolean).length + preset.referenceFiles.length;
  const colors = preset.brandColors ?? [];

  return (
    <div className="group relative flex flex-col rounded-[18px] border border-line bg-surface-2 transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-line-strong">
      <button type="button" onClick={onOpen} className="flex flex-1 flex-col p-6 text-left focus-visible:outline-offset-[-2px]">
        <div className="flex items-start gap-4 pr-10">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-[12px] border border-line-strong bg-surface-1 text-ink-2">
            {type.icon(19)}
          </span>
          <div className="min-w-0 pt-0.5">
            <h3 className="truncate text-[15px] font-medium tracking-[-0.01em] text-ink">{preset.name}</h3>
            <p className="mt-0.5 truncate text-[13px] text-ink-3">{preset.builtIn ? type.label : preset.clientName || 'No client'}</p>
          </div>
        </div>

        <p className="mt-5 line-clamp-3 min-h-[3.9em] text-[13.5px] leading-relaxed text-ink-2">
          {preset.creativeBrief || <span className="text-ink-3">No creative brief yet.</span>}
        </p>

        <div className="mt-5 flex flex-col gap-3 border-t border-line pt-4 text-[12.5px] text-ink-3">
          <div className="flex items-center justify-between gap-3">
            {preset.builtIn ? <Badge tone="outline">Built-in</Badge> : <Badge tone="neutral">{type.label}</Badge>}
            {colors.length > 0 && (
              <span className="flex items-center -space-x-1" aria-label={`${colors.length} brand colours`}>
                {colors.slice(0, 5).map((c, i) => (
                  <span key={i} className="size-[18px] rounded-full border-2 border-surface-2" style={{ background: c }} />
                ))}
              </span>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-4">
            <span className="flex min-w-0 items-center gap-1.5">
              <IconType size={14} className="shrink-0" />
              <span className="truncate">{preset.fonts || 'No fonts'}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              {preset.referenceFiles.length ? <IconFilm size={14} /> : <IconLink size={14} />}
              <span className="timecode">{refCount}</span>
            </span>
            {!preset.builtIn && <span className="ml-auto shrink-0">{formatRelative(preset.updatedAt)}</span>}
          </div>
        </div>
      </button>
      {footer && <div className="border-t border-line px-6 py-4">{footer}</div>}
      {menuItems && (
        <div className="absolute top-5 right-4">
          <Menu
            items={menuItems}
            trigger={(props) => (
              <IconButton label={`Actions for ${preset.name}`} size="sm" {...props}>
                <IconMore size={18} />
              </IconButton>
            )}
          />
        </div>
      )}
    </div>
  );
}
