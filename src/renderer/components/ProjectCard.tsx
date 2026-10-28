import type { Project } from '../types';
import { presetTypeInfo, projectStatusInfo } from '../lib/catalog';
import { formatClock, formatRelative } from '../lib/time';
import { fileName, getSegments } from '../lib/project';
import { Badge, IconButton, Menu, cn, type MenuItem } from './ui';
import { IconFilm, IconMore } from './ui/icons';

interface ProjectCardProps {
  project: Project;
  onOpen: () => void;
  menuItems: Array<MenuItem | 'divider'>;
  layout?: 'grid' | 'list';
}

function ProjectMeta({ project }: { project: Project }) {
  const segments = getSegments(project);
  const approved = segments.filter((s) => s.status === 'approved').length;
  return (
    <div className="flex items-center justify-between gap-3 text-[12.5px] text-ink-3">
      <span className="timecode truncate">
        {segments.length ? `${approved}/${segments.length} approved` : 'No segments'}
      </span>
      <span className="shrink-0">{formatRelative(project.updatedAt)}</span>
    </div>
  );
}

export function ProjectCard({ project, onOpen, menuItems, layout = 'grid' }: ProjectCardProps) {
  const status = projectStatusInfo(project.status);
  const type = presetTypeInfo(project.presetType);
  const segments = getSegments(project);
  const approved = segments.filter((s) => s.status === 'approved').length;
  const progress = segments.length ? approved / segments.length : 0;

  const menu = (
    <Menu
      items={menuItems}
      trigger={(props) => (
        <IconButton label={`Actions for ${project.name}`} size="sm" {...props}>
          <IconMore size={18} />
        </IconButton>
      )}
    />
  );

  if (layout === 'list') {
    return (
      <div className="group flex min-h-[76px] items-center gap-5 rounded-[14px] border border-line bg-surface-2 py-3 pr-3 pl-5 transition-colors hover:border-line-strong">
        <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-5 self-stretch rounded-[10px] text-left">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-[12px] border border-line-strong bg-surface-1 text-ink-2">
            {type.icon(19)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-medium text-ink">{project.name}</span>
            <span className="mt-0.5 block truncate text-[13px] text-ink-3">
              {[project.clientName, project.presetName].filter(Boolean).join(' · ')}
            </span>
          </span>
          <span className="hidden w-56 shrink-0 xl:block">
            <ProjectMeta project={project} />
          </span>
          <Badge tone={status.tone} dot>
            {status.label}
          </Badge>
        </button>
        {menu}
      </div>
    );
  }

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-[18px] border border-line bg-surface-2 transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-line-strong">
      <button type="button" onClick={onOpen} className="flex flex-1 flex-col text-left focus-visible:outline-offset-[-2px]">
        <div className="relative flex aspect-[16/8] items-center justify-center overflow-hidden border-b border-line bg-surface-1">
          <div className="grid-bg absolute inset-0 opacity-70" />
          {project.source ? (
            <div className="relative flex max-w-[80%] items-center gap-2.5 rounded-full border border-line-strong bg-surface-2/90 px-3.5 py-2 text-[12.5px] text-ink-2">
              <IconFilm size={15} className="shrink-0" />
              <span className="truncate">{fileName(project.source.path)}</span>
              {project.source.duration ? <span className="timecode shrink-0 text-ink-3">{formatClock(project.source.duration)}</span> : null}
            </div>
          ) : (
            <span className="relative flex size-12 items-center justify-center rounded-[14px] border border-line-strong bg-surface-2 text-ink-2">
              {type.icon(22)}
            </span>
          )}
          <div className="absolute top-3.5 left-3.5">
            <Badge tone={status.tone} dot>
              {status.label}
            </Badge>
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-1.5 p-5">
          <h3 className="truncate text-[15px] font-medium tracking-[-0.01em] text-ink" title={project.name}>
            {project.name}
          </h3>
          <p className="truncate text-[13px] text-ink-3">{[project.clientName, project.presetName].filter(Boolean).join(' · ') || 'No preset'}</p>
          <div className="mt-auto pt-3">
            <ProjectMeta project={project} />
          </div>
        </div>
      </button>
      <div className="h-[3px] bg-surface-3" aria-label={`${Math.round(progress * 100)}% of segments approved`}>
        <div className={cn('h-full bg-success transition-[width]')} style={{ width: `${progress * 100}%` }} />
      </div>
      <div className="absolute top-2.5 right-2.5 rounded-[10px] bg-surface-2/80 backdrop-blur-sm">{menu}</div>
    </div>
  );
}
