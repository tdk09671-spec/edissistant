import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useData } from '../state/DataProvider';
import { Page } from '../components/Layout';
import { useNewProject } from '../components/NewProjectModal';
import { ProjectCard } from '../components/ProjectCard';
import { useProjectActions } from '../components/ProjectActions';
import { projectStatuses } from '../lib/catalog';
import { Button, EmptyState, IconButton, Input, PageHeader, SegmentedControl, Select, Skeleton } from '../components/ui';
import { IconClose, IconFolder, IconGrid, IconList, IconPlus, IconSearch } from '../components/ui/icons';
import type { ProjectStatus } from '../types';

type StatusFilter = 'all' | ProjectStatus;
type SortKey = 'recent' | 'name' | 'created';

function readPref<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T) || fallback;
  } catch {
    return fallback;
  }
}

export default function Projects() {
  const navigate = useNavigate();
  const openNewProject = useNewProject();
  const { projects, loading } = useData();
  const { itemsFor, dialogs } = useProjectActions();

  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<SortKey>('recent');
  const [view, setView] = useState<'grid' | 'list'>(() => readPref('projects.view', 'grid'));

  const changeView = (next: 'grid' | 'list') => {
    setView(next);
    try {
      localStorage.setItem('projects.view', next);
    } catch {
      // Preference is optional
    }
  };

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = { all: projects.length, draft: 0, 'in-progress': 0, completed: 0 };
    projects.forEach((p) => c[p.status]++);
    return c;
  }, [projects]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects
      .filter((p) => status === 'all' || p.status === status)
      .filter((p) => !q || [p.name, p.clientName, p.presetName].some((v) => v?.toLowerCase().includes(q)))
      .sort((a, b) =>
        sort === 'name' ? a.name.localeCompare(b.name) : sort === 'created' ? b.createdAt.localeCompare(a.createdAt) : b.updatedAt.localeCompare(a.updatedAt)
      );
  }, [projects, query, status, sort]);

  return (
    <Page>
      <PageHeader
        eyebrow="Workspace"
        title="Projects"
        description="Every edit you are planning, reviewing or delivering."
        actions={
          <Button variant="primary" icon={<IconPlus size={17} />} onClick={() => openNewProject()}>
            New project
          </Button>
        }
      />

      {projects.length > 0 && (
        <div className="mt-10 flex flex-wrap items-center gap-3">
          <Input
            aria-label="Search projects"
            placeholder="Search projects"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            leading={<IconSearch size={17} />}
            trailing={
              query && (
                <IconButton label="Clear search" size="sm" onClick={() => setQuery('')}>
                  <IconClose size={15} />
                </IconButton>
              )
            }
            className="max-w-[340px] min-w-[200px] flex-1"
          />
          <SegmentedControl<StatusFilter>
            label="Filter by status"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: <>All <span className="timecode text-ink-3">{counts.all}</span></> },
              ...projectStatuses.map((s) => ({
                value: s.value as StatusFilter,
                label: (
                  <>
                    {s.label} <span className="timecode text-ink-3">{counts[s.value]}</span>
                  </>
                ),
              })),
            ]}
          />
          <div className="ml-auto flex items-center gap-2">
            <Select aria-label="Sort projects" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="w-[156px]">
              <option value="recent">Last edited</option>
              <option value="created">Date created</option>
              <option value="name">Name A–Z</option>
            </Select>
            <SegmentedControl
              label="Layout"
              value={view}
              onChange={changeView}
              options={[
                { value: 'grid', label: <span className="sr-only">Grid</span>, icon: <IconGrid size={16} />, title: 'Grid view' },
                { value: 'list', label: <span className="sr-only">List</span>, icon: <IconList size={16} />, title: 'List view' },
              ]}
            />
          </div>
        </div>
      )}

      <div className="mt-8">
        {loading ? (
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-[248px]" />
            ))}
          </div>
        ) : projects.length === 0 ? (
          <EmptyState
            icon={<IconFolder size={22} />}
            title="No projects yet"
            description="A project pairs your footage with a preset, then lets you plan, review and deliver the edit segment by segment."
            action={
              <Button variant="primary" icon={<IconPlus size={17} />} onClick={() => openNewProject()}>
                Create your first project
              </Button>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            compact
            icon={<IconSearch size={20} />}
            title="No matching projects"
            description="Try a different search or status filter."
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setQuery('');
                  setStatus('all');
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : view === 'grid' ? (
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-3 2xl:grid-cols-4">
            {filtered.map((project) => (
              <ProjectCard key={project.id} project={project} onOpen={() => navigate(`/projects/${project.id}`)} menuItems={itemsFor(project)} />
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {filtered.map((project) => (
              <ProjectCard
                key={project.id}
                layout="list"
                project={project}
                onOpen={() => navigate(`/projects/${project.id}`)}
                menuItems={itemsFor(project)}
              />
            ))}
          </div>
        )}
      </div>
      {dialogs}
    </Page>
  );
}
