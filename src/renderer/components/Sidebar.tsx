import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useData } from '../state/DataProvider';
import { useNewProject } from './NewProjectModal';
import { Button, Tooltip, cn } from './ui';
import { IconFolder, IconHome, IconLayers, IconPlus, IconSettings, IconSidebar } from './ui/icons';

const navItems = [
  { path: '/', label: 'Home', icon: IconHome },
  { path: '/projects', label: 'Projects', icon: IconFolder },
  { path: '/presets', label: 'Presets', icon: IconLayers },
];

type SidebarMode = 'auto' | 'expanded' | 'collapsed';
const MODE_KEY = 'sidebar.mode';
const COMPACT_QUERY = '(max-width: 1199px)';

function useCompactWindow() {
  const [compact, setCompact] = useState(() => window.matchMedia(COMPACT_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(COMPACT_QUERY);
    const onChange = () => setCompact(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return compact;
}

function readMode(): SidebarMode {
  try {
    return (localStorage.getItem(MODE_KEY) as SidebarMode) || 'auto';
  } catch {
    return 'auto';
  }
}

function NavItem({ path, label, icon: Icon, active, collapsed }: { path: string; label: string; icon: typeof IconHome; active: boolean; collapsed: boolean }) {
  const link = (
    <NavLink
      to={path}
      aria-label={collapsed ? label : undefined}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative flex h-11 items-center rounded-[10px] text-sm font-medium transition-colors',
        collapsed ? 'w-11 justify-center' : 'gap-3 px-3',
        active ? 'bg-surface-3 text-ink' : 'text-ink-3 hover:bg-surface-2 hover:text-ink'
      )}
    >
      {active && <span className="absolute top-2.5 bottom-2.5 left-0 w-[3px] rounded-full bg-signal" />}
      <Icon size={19} className={cn('shrink-0', active ? 'text-ink' : 'text-ink-3 group-hover:text-ink-2')} />
      {!collapsed && <span>{label}</span>}
    </NavLink>
  );
  return collapsed ? <Tooltip content={label}>{link}</Tooltip> : link;
}

export default function Sidebar() {
  const location = useLocation();
  const { projects } = useData();
  const openNewProject = useNewProject();
  const compactWindow = useCompactWindow();
  const [mode, setMode] = useState<SidebarMode>(readMode);
  const collapsed = mode === 'auto' ? compactWindow : mode === 'collapsed';

  const toggle = () => {
    const next: SidebarMode = collapsed ? 'expanded' : 'collapsed';
    // Returning to the size that "auto" would pick anyway resets to automatic behaviour.
    const stored: SidebarMode = (next === 'collapsed') === compactWindow ? 'auto' : next;
    setMode(stored);
    try {
      localStorage.setItem(MODE_KEY, stored);
    } catch {
      // optional preference
    }
  };

  const isActive = (path: string) => (path === '/' ? location.pathname === '/' : location.pathname.startsWith(path));
  const recent = [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4);

  return (
    <nav
      aria-label="Main"
      className={cn('flex shrink-0 flex-col border-r border-line bg-surface-1 transition-[width] duration-200', collapsed ? 'w-[76px]' : 'w-[248px]')}
    >
      <div className={cn('flex items-center pt-6 pb-5', collapsed ? 'justify-center' : 'gap-3 px-5')}>
        <div className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-ink text-[17px] font-bold tracking-[-0.04em] text-canvas">E</div>
        {!collapsed && (
          <div className="min-w-0">
            <p className="text-[15px] leading-tight font-semibold tracking-[-0.02em] text-ink">Edissistant</p>
            <p className="text-xs leading-tight text-ink-3">Production assistant</p>
          </div>
        )}
      </div>

      <div className={cn('pb-4', collapsed ? 'flex justify-center' : 'px-4')}>
        {collapsed ? (
          <Tooltip content="New project">
            <button
              type="button"
              aria-label="New project"
              onClick={() => openNewProject()}
              className="flex size-11 items-center justify-center rounded-full bg-ink text-canvas transition-colors hover:bg-white"
            >
              <IconPlus size={18} />
            </button>
          </Tooltip>
        ) : (
          <Button variant="primary" className="w-full" icon={<IconPlus size={17} />} onClick={() => openNewProject()}>
            New project
          </Button>
        )}
      </div>

      <div className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto', collapsed ? 'items-center px-0' : 'px-3')}>
        <div className="flex flex-col gap-1">
          {navItems.map((item) => (
            <NavItem key={item.path} {...item} active={isActive(item.path)} collapsed={collapsed} />
          ))}
        </div>

        {!collapsed && recent.length > 0 && (
          <div className="mt-8">
            <p className="eyebrow px-3 pb-2">Recent</p>
            <div className="flex flex-col gap-0.5">
              {recent.map((project) => {
                const active = location.pathname.startsWith(`/projects/${project.id}`);
                return (
                  <NavLink
                    key={project.id}
                    to={`/projects/${project.id}`}
                    title={project.name}
                    className={cn(
                      'flex h-10 min-w-0 items-center gap-3 rounded-[10px] px-3 text-[13.5px] transition-colors',
                      active ? 'bg-surface-3 text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'
                    )}
                  >
                    <span
                      className={cn(
                        'size-1.5 shrink-0 rounded-full',
                        project.status === 'completed' ? 'bg-success' : project.status === 'in-progress' ? 'bg-signal' : 'bg-ink-4'
                      )}
                    />
                    <span className="truncate">{project.name}</span>
                  </NavLink>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className={cn('border-t border-line py-3', collapsed ? 'flex flex-col items-center gap-1' : 'px-3')}>
        <NavItem path="/settings" label="Settings" icon={IconSettings} active={isActive('/settings')} collapsed={collapsed} />
        <div className={cn('flex items-center', collapsed ? 'justify-center' : 'justify-between gap-2 pt-2 pl-3')}>
          {!collapsed && <p className="text-xs leading-relaxed text-ink-3">For an editor, by an editor.</p>}
          <Tooltip content={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            <button
              type="button"
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!collapsed}
              onClick={toggle}
              className="flex size-10 shrink-0 items-center justify-center rounded-[10px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <IconSidebar size={18} />
            </button>
          </Tooltip>
        </div>
      </div>
    </nav>
  );
}
