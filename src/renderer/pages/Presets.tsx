import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { v4 as uuid } from 'uuid';
import { useData } from '../state/DataProvider';
import { Page } from '../components/Layout';
import { PresetCard } from '../components/PresetCard';
import { useNewProject } from '../components/NewProjectModal';
import { builtInPresets, presetTypes } from '../lib/catalog';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  IconButton,
  Input,
  PageHeader,
  SectionHeader,
  SegmentedControl,
  Skeleton,
  useToast,
} from '../components/ui';
import { IconArrowRight, IconClose, IconCopy, IconEdit, IconLayers, IconPlus, IconSearch, IconTrash } from '../components/ui/icons';
import type { Preset, PresetType } from '../types';

type TypeFilter = 'all' | PresetType;

export default function Presets() {
  const navigate = useNavigate();
  const toast = useToast();
  const openNewProject = useNewProject();
  const { presets, projects, savePresets, settings, loading } = useData();
  const [query, setQuery] = useState('');
  const [type, setType] = useState<TypeFilter>('all');
  const [deleting, setDeleting] = useState<Preset | null>(null);

  const matches = (p: Preset) => {
    const q = query.trim().toLowerCase();
    return (type === 'all' || p.type === type) && (!q || [p.name, p.clientName, p.creativeBrief, p.fonts].some((v) => v?.toLowerCase().includes(q)));
  };

  const userPresets = [...presets].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).filter(matches);
  const templates = builtInPresets.filter(matches);

  const handleDuplicate = async (preset: Preset) => {
    const now = new Date().toISOString();
    const dup: Preset = { ...structuredClone(preset), builtIn: undefined, id: uuid(), name: `${preset.name} (copy)`, createdAt: now, updatedAt: now };
    await savePresets((all) => [...all, dup]);
    toast('Preset duplicated', { description: dup.name });
  };

  const handleDelete = async (preset: Preset) => {
    await savePresets((all) => all.filter((p) => p.id !== preset.id));
    setDeleting(null);
    toast('Preset deleted', { description: preset.name });
  };

  const usageCount = (preset: Preset) => projects.filter((p) => p.presetId === preset.id).length;

  return (
    <Page>
      <PageHeader
        eyebrow="Library"
        title="Presets"
        description="Client presets hold references, typography and brand rules, so every project starts on-brand."
        actions={
          <Button variant="primary" icon={<IconPlus size={17} />} onClick={() => navigate('/presets/new')}>
            New preset
          </Button>
        }
      />

      <div className="mt-10 flex flex-wrap items-center gap-3">
        <Input
          aria-label="Search presets"
          placeholder="Search presets"
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
          className="w-full max-w-[340px] min-w-[220px] flex-1"
        />
        <SegmentedControl<TypeFilter>
          label="Filter by category"
          value={type}
          onChange={setType}
          options={[{ value: 'all', label: 'All' }, ...presetTypes.map((t) => ({ value: t.value as TypeFilter, label: t.label }))]}
        />
      </div>

      <section className="mt-10" aria-labelledby="user-presets">
        <SectionHeader title={<span id="user-presets">Your presets</span>} count={loading ? undefined : presets.length} />
        <div className="mt-6">
          {loading ? (
            <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-[236px]" />
              ))}
            </div>
          ) : presets.length === 0 ? (
            <EmptyState
              icon={<IconLayers size={22} />}
              title="No client presets yet"
              description="Build one from scratch or customise a built-in template below. Presets are saved on this computer."
              action={
                <Button variant="primary" icon={<IconPlus size={17} />} onClick={() => navigate('/presets/new')}>
                  Create a preset
                </Button>
              }
            />
          ) : userPresets.length === 0 ? (
            <EmptyState compact icon={<IconSearch size={20} />} title="No presets match" description="Try another search or category." />
          ) : (
            <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
              {userPresets.map((preset) => (
                <PresetCard
                  key={preset.id}
                  preset={preset}
                  onOpen={() => navigate(`/presets/${preset.id}`)}
                  menuItems={[
                    { label: 'New project with preset', icon: <IconArrowRight size={16} />, onSelect: () => openNewProject({ presetId: preset.id }) },
                    { label: 'Edit', icon: <IconEdit size={16} />, onSelect: () => navigate(`/presets/${preset.id}`) },
                    { label: 'Duplicate', icon: <IconCopy size={16} />, onSelect: () => handleDuplicate(preset) },
                    'divider',
                    {
                      label: 'Delete',
                      icon: <IconTrash size={16} />,
                      danger: true,
                      onSelect: () => (settings.confirmBeforeDelete ? setDeleting(preset) : handleDelete(preset)),
                    },
                  ]}
                />
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="mt-14" aria-labelledby="templates">
        <SectionHeader
          title={<span id="templates">Built-in templates</span>}
          description="Read-only starting points. Customising one creates your own editable copy."
        />
        {templates.length === 0 ? (
          <p className="mt-6 text-[13.5px] text-ink-3">No templates match your filters.</p>
        ) : (
          <div className="mt-6 grid grid-cols-2 gap-4 xl:grid-cols-3">
            {templates.map((preset) => (
              <PresetCard
                key={preset.id}
                preset={preset}
                onOpen={() => navigate(`/presets/new?from=${preset.id}`)}
                footer={
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="secondary" onClick={() => navigate(`/presets/new?from=${preset.id}`)}>
                      Customise
                    </Button>
                    <Button size="sm" variant="ghost" iconRight={<IconArrowRight size={15} />} onClick={() => openNewProject({ presetId: preset.id })}>
                      Start project
                    </Button>
                  </div>
                }
              />
            ))}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={Boolean(deleting)}
        title="Delete this preset?"
        description={
          deleting && (
            <>
              <span className="font-medium text-ink">{deleting.name}</span> will be removed permanently.
              {usageCount(deleting) > 0 &&
                ` ${usageCount(deleting)} existing ${usageCount(deleting) === 1 ? 'project keeps' : 'projects keep'} working and will still show the preset name.`}
            </>
          )
        }
        confirmLabel="Delete preset"
        destructive
        onConfirm={() => deleting && handleDelete(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </Page>
  );
}
