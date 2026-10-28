import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { v4 as uuid } from 'uuid';
import { useData } from '../state/DataProvider';
import { builtInPresets, presetTypeInfo } from '../lib/catalog';
import type { Preset, PresetType, Project } from '../types';
import { Badge, Button, Field, Input, Modal, cn, useToast } from './ui';
import { IconCheck, IconPlus } from './ui/icons';

interface OpenOptions {
  presetId?: string;
  type?: PresetType;
}

const NewProjectContext = createContext<(options?: OpenOptions) => void>(() => undefined);

export function useNewProject() {
  return useContext(NewProjectContext);
}

export function NewProjectProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ open: boolean; options: OpenOptions }>({ open: false, options: {} });
  const open = useCallback((options: OpenOptions = {}) => setState({ open: true, options }), []);
  const close = useCallback(() => setState((s) => ({ ...s, open: false })), []);

  return (
    <NewProjectContext.Provider value={open}>
      {children}
      {state.open && <NewProjectDialog options={state.options} onClose={close} />}
    </NewProjectContext.Provider>
  );
}

function PresetOption({ preset, selected, onSelect }: { preset: Preset; selected: boolean; onSelect: () => void }) {
  const info = presetTypeInfo(preset.type);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'flex min-h-14 w-full items-center gap-3.5 rounded-[12px] border px-3.5 py-2.5 text-left transition-colors',
        selected ? 'border-signal/60 bg-signal-soft' : 'border-line bg-surface-1 hover:border-line-strong hover:bg-surface-3'
      )}
    >
      <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-[10px] border', selected ? 'border-signal/40 text-signal' : 'border-line-strong text-ink-2')}>
        {info.icon(17)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">{preset.name}</span>
        <span className="block truncate text-[12.5px] text-ink-3">
          {preset.builtIn ? 'Built-in template' : preset.clientName || 'No client'} · {info.label}
        </span>
      </span>
      {selected && <IconCheck size={17} className="shrink-0 text-signal" strokeWidth={2.2} />}
    </button>
  );
}

function NewProjectDialog({ options, onClose }: { options: OpenOptions; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { presets, saveProjects } = useData();

  const userPresets = useMemo(() => [...presets].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [presets]);
  const allPresets = useMemo(() => [...userPresets, ...builtInPresets], [userPresets]);

  // Always start with a sensible preset selected: requested one, else matching type, else most recent, else first template.
  const initialPreset =
    allPresets.find((p) => p.id === options.presetId) ??
    (options.type ? userPresets.find((p) => p.type === options.type) ?? builtInPresets.find((p) => p.type === options.type) : undefined) ??
    userPresets[0] ??
    builtInPresets[0];

  const [name, setName] = useState('');
  const [presetId, setPresetId] = useState(initialPreset?.id ?? '');
  const [clientName, setClientName] = useState(initialPreset?.clientName ?? '');
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);

  const selectPreset = (preset: Preset) => {
    setPresetId(preset.id);
    if (!clientName.trim() || allPresets.some((p) => p.clientName === clientName)) setClientName(preset.clientName);
  };

  const preset = allPresets.find((p) => p.id === presetId);
  const nameError = touched && !name.trim() ? 'Give the project a name.' : undefined;

  const handleCreate = async () => {
    setTouched(true);
    if (!name.trim() || !preset) return;
    setSaving(true);
    const now = new Date().toISOString();
    const project: Project = {
      id: uuid(),
      name: name.trim(),
      presetId: preset.id,
      presetName: preset.name,
      presetType: preset.type,
      clientName: clientName.trim(),
      status: 'draft',
      segments: [],
      comments: [],
      versions: [],
      createdAt: now,
      updatedAt: now,
    };
    await saveProjects((all) => [...all, project]);
    setSaving(false);
    onClose();
    toast('Project created', { description: project.name });
    navigate(`/projects/${project.id}`);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="New project"
      description="Name the project and choose the preset that defines its creative direction."
      size="md"
      dismissible={!saving}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleCreate} loading={saving} disabled={!preset}>
            Create project
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          handleCreate();
        }}
      >
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-[1.4fr_1fr]">
          <Field label="Project name" required htmlFor="np-name" error={nameError}>
            <Input
              id="np-name"
              data-autofocus
              value={name}
              invalid={Boolean(nameError)}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setTouched(true)}
              placeholder="e.g. Spring launch — hero film"
            />
          </Field>
          <Field label="Client" optional htmlFor="np-client">
            <Input id="np-client" value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="e.g. Northwind" />
          </Field>
        </div>

        <Field label="Preset" required>
          <div role="radiogroup" aria-label="Preset" className="flex max-h-[min(320px,40vh)] flex-col gap-2 overflow-y-auto pr-1">
            {userPresets.length > 0 && <p className="eyebrow pt-1 pb-1">Your presets</p>}
            {userPresets.map((p) => (
              <PresetOption key={p.id} preset={p} selected={p.id === presetId} onSelect={() => selectPreset(p)} />
            ))}
            <p className="eyebrow flex items-center gap-2 pt-3 pb-1">
              Templates <Badge tone="outline">Built-in</Badge>
            </p>
            {builtInPresets.map((p) => (
              <PresetOption key={p.id} preset={p} selected={p.id === presetId} onSelect={() => selectPreset(p)} />
            ))}
          </div>
        </Field>
        <button type="submit" hidden />
        <button
          type="button"
          onClick={() => {
            onClose();
            navigate('/presets/new');
          }}
          className="-mt-2 inline-flex items-center gap-2 self-start rounded-[8px] text-[13px] font-medium text-ink-2 hover:text-ink"
        >
          <IconPlus size={15} /> Create a new client preset instead
        </button>
      </form>
    </Modal>
  );
}
