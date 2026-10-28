import { useNavigate } from 'react-router-dom';
import { useData } from '../state/DataProvider';
import { Page } from '../components/Layout';
import { useNewProject } from '../components/NewProjectModal';
import { ProjectCard } from '../components/ProjectCard';
import { useProjectActions } from '../components/ProjectActions';
import { presetTypes } from '../lib/catalog';
import { getSegments } from '../lib/project';
import { Button, EmptyState, SectionHeader, Skeleton } from '../components/ui';
import { IconArrowRight, IconFolder, IconPlus } from '../components/ui/icons';
import type { PresetType } from '../types';

const creationCards: Array<{ type: PresetType | 'new-preset'; title: string; description: string }> = [
  { type: 'product-animation', title: 'Product Animation', description: presetTypes[0].description },
  { type: 'podcast-trailer', title: 'Podcast Trailer', description: presetTypes[1].description },
  { type: 'talking-head-intro', title: 'Talking Head Intro', description: presetTypes[2].description },
  { type: 'new-preset', title: 'Create Your Own Preset', description: 'Capture a client’s references, type and brand rules once. Reuse them on every job.' },
];

function greeting() {
  const hour = new Date().getHours();
  if (hour < 5) return 'Working late';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export default function Dashboard() {
  const navigate = useNavigate();
  const openNewProject = useNewProject();
  const { projects, presets, loading } = useData();
  const { itemsFor, dialogs } = useProjectActions();

  const recentProjects = [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6);
  const inProgress = projects.filter((p) => p.status === 'in-progress').length;
  const needsRevision = projects.reduce((n, p) => n + getSegments(p).filter((s) => s.status === 'needs-revision').length, 0);

  const stats = [
    { label: 'Active projects', value: inProgress },
    { label: 'Segments to revise', value: needsRevision },
    { label: 'Client presets', value: presets.length },
  ];

  return (
    <Page>
      {/* Header */}
      <section className="relative -mx-8 -mt-10 mb-10 overflow-hidden px-8 pt-10 pb-2 xl:-mx-12 xl:-mt-12 xl:px-12 xl:pt-14">
        <div className="grid-bg pointer-events-none absolute inset-0" aria-hidden="true" />
        <div className="relative flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
          <div className="max-w-[520px] min-w-0 flex-1">
            <p className="eyebrow mb-4 flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-success" />
              {greeting()}
            </p>
            <h1 className="text-display font-semibold text-ink">
              What are we
              <br />
              <span className="text-ink-3">cutting today?</span>
            </h1>
            <p className="mt-4 text-[15px] leading-relaxed text-ink-2">
              Plan every segment, direct every cut and keep each client’s style consistent — in one calm workspace.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Button variant="primary" size="lg" icon={<IconPlus size={18} />} onClick={() => openNewProject()}>
                New project
              </Button>
              <Button variant="ghost" size="lg" iconRight={<IconArrowRight size={17} />} onClick={() => navigate('/projects')}>
                All projects
              </Button>
            </div>
          </div>
          <dl className="flex gap-3">
            {stats.map((stat) => (
              <div key={stat.label} className="min-w-[116px] rounded-[14px] border border-line bg-surface-1/80 px-4 py-3.5 backdrop-blur-sm">
                <dt className="text-[12.5px] text-ink-3">{stat.label}</dt>
                <dd className="timecode mt-1 text-[26px] font-medium text-ink">{loading ? '–' : stat.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* Creation */}
      <section aria-labelledby="create-heading">
        <SectionHeader
          title={<span id="create-heading">Start something new</span>}
          description="Pick a format to start a project with a ready-made creative direction."
        />
        <div className="mt-6 grid grid-cols-2 gap-4 xl:grid-cols-4">
          {creationCards.map((card, index) => {
            const isPreset = card.type === 'new-preset';
            const icon = isPreset ? presetTypes[3].icon(22) : presetTypes.find((t) => t.value === card.type)!.icon(22);
            return (
              <button
                key={card.type}
                type="button"
                onClick={() => (isPreset ? navigate('/presets/new') : openNewProject({ type: card.type as PresetType }))}
                className={
                  'group relative flex min-h-[200px] flex-col rounded-[18px] border p-6 text-left transition-[border-color,background-color,transform] duration-200 hover:-translate-y-0.5 ' +
                  (isPreset
                    ? 'border-dashed border-line-strong bg-transparent hover:border-signal/50 hover:bg-signal-soft'
                    : 'border-line bg-surface-2 hover:border-line-strong hover:bg-[#1a1b21]')
                }
              >
                <div className="flex items-start justify-between">
                  <span
                    className={
                      'flex size-12 items-center justify-center rounded-[14px] border transition-colors ' +
                      (isPreset ? 'border-signal/30 text-signal' : 'border-line-strong bg-surface-1 text-ink-2 group-hover:text-ink')
                    }
                  >
                    {icon}
                  </span>
                  <span className="timecode text-[13px] text-ink-4">{String(index + 1).padStart(2, '0')}</span>
                </div>
                <h3 className="mt-auto pt-6 text-[17px] font-semibold tracking-[-0.015em] text-ink">{card.title}</h3>
                <p className="mt-2 text-[13.5px] leading-relaxed text-ink-3">{card.description}</p>
                <span className="mt-5 flex items-center gap-2 text-[13px] font-medium text-ink-2 transition-colors group-hover:text-ink">
                  {isPreset ? 'Open preset builder' : 'Start project'}
                  <IconArrowRight size={15} className="transition-transform duration-200 group-hover:translate-x-0.5" />
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Recent projects */}
      <section aria-labelledby="recent-heading" className="mt-14">
        <SectionHeader
          title={<span id="recent-heading">Recent projects</span>}
          count={loading ? undefined : projects.length}
          action={
            projects.length > 0 && (
              <Button variant="ghost" size="sm" iconRight={<IconArrowRight size={15} />} onClick={() => navigate('/projects')}>
                View all
              </Button>
            )
          }
        />
        <div className="mt-6">
          {loading ? (
            <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-[248px]" />
              ))}
            </div>
          ) : recentProjects.length === 0 ? (
            <EmptyState
              icon={<IconFolder size={22} />}
              title="No projects yet"
              description="Create a project from a template or one of your client presets. Your recent work will appear here."
              action={
                <Button variant="primary" icon={<IconPlus size={17} />} onClick={() => openNewProject()}>
                  Create your first project
                </Button>
              }
            />
          ) : (
            <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
              {recentProjects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  onOpen={() => navigate(`/projects/${project.id}`)}
                  menuItems={itemsFor(project)}
                />
              ))}
            </div>
          )}
        </div>
      </section>
      {dialogs}
    </Page>
  );
}
