import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { useData } from '../state/DataProvider';
import { UnsavedChangesGuard } from '../components/UnsavedChangesGuard';
import { projectStatuses } from '../lib/catalog';
import { projectFps } from '../lib/project';
import { Button, EmptyState, IconButton, LoadingState, Select, Tooltip, cn, useToast } from '../components/ui';
import { IconArrowLeft, IconCheck, IconEdit, IconFolder, IconRedo, IconSave, IconUndo } from '../components/ui/icons';
import type { Project, ProjectStatus } from '../types';
import { usePipeline, type Pipeline } from './project/usePipeline';

export interface ProjectContext {
  project: Project;
  /** Apply a change to the working copy. Persisted automatically when auto-save is on. */
  update: (updater: (project: Project) => Project) => void;
  fps: number;
  selectedSegmentId: string | null;
  setSelectedSegmentId: (id: string | null) => void;
  /** Transcribe → plan → approve → render → export for this project. */
  pipeline: Pipeline;
}

export function useProject() {
  return useOutletContext<ProjectContext>();
}

const HISTORY_LIMIT = 60;
const COALESCE_MS = 900;

export default function ProjectEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { projects, presets, settings, updateProject, loading } = useData();
  const stored = projects.find((p) => p.id === id);

  const [working, setWorking] = useState<Project | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<'saved' | 'saving'>('saved');
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  const workingRef = useRef<Project | null>(null);
  const past = useRef<Project[]>([]);
  const future = useRef<Project[]>([]);
  const lastPush = useRef(0);
  const saveTimer = useRef<number | undefined>(undefined);
  const [, forceHistory] = useState(0);

  // Load the working copy when the project changes (or first becomes available)
  useEffect(() => {
    if (!stored || workingRef.current?.id === stored.id) return;
    workingRef.current = stored;
    setWorking(stored);
    setDirty(false);
    past.current = [];
    future.current = [];
    setSelectedSegmentId(null);
  }, [stored]);

  const commit = useCallback(async () => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    const current = workingRef.current;
    if (!current) return;
    setSaveState('saving');
    await updateProject(current.id, () => current);
    setSaveState('saved');
    setDirty(false);
  }, [updateProject]);

  const schedule = useCallback(() => {
    setDirty(true);
    if (!settings.autoSave) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(commit, 600);
  }, [settings.autoSave, commit]);

  const update = useCallback(
    (updater: (project: Project) => Project) => {
      const current = workingRef.current;
      if (!current) return;
      const now = Date.now();
      if (now - lastPush.current > COALESCE_MS) {
        past.current = [...past.current.slice(-HISTORY_LIMIT + 1), current];
        future.current = [];
        forceHistory((n) => n + 1);
      }
      lastPush.current = now;
      const next = updater(current);
      workingRef.current = next;
      setWorking(next);
      schedule();
    },
    [schedule]
  );

  const pipeline = usePipeline(workingRef, update, presets, settings);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev || !workingRef.current) return;
    future.current.push(workingRef.current);
    workingRef.current = prev;
    setWorking(prev);
    lastPush.current = 0;
    forceHistory((n) => n + 1);
    schedule();
  }, [schedule]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next || !workingRef.current) return;
    past.current.push(workingRef.current);
    workingRef.current = next;
    setWorking(next);
    lastPush.current = 0;
    forceHistory((n) => n + 1);
    schedule();
  }, [schedule]);

  // Flush a pending auto-save when leaving the project
  const pendingFlush = useRef<() => void>(() => undefined);
  pendingFlush.current = () => {
    if (!settings.autoSave || saveTimer.current === undefined) return;
    window.clearTimeout(saveTimer.current);
    const current = workingRef.current;
    if (current && current !== stored) updateProject(current.id, () => current);
  };
  useEffect(() => () => pendingFlush.current(), []);

  // Keyboard: Ctrl/Cmd+S save, Ctrl+Z undo, Ctrl+Shift+Z / Ctrl+Y redo (outside text fields)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 's') {
        e.preventDefault();
        commit().then(() => toast('Project saved'));
        return;
      }
      if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [commit, undo, redo, toast]);

  if (loading) return <LoadingState label="Opening project…" />;

  if (!stored || !working) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <EmptyState
          icon={<IconFolder size={22} />}
          title="Project not found"
          description="It may have been deleted. Your other projects are safe."
          action={
            <Button variant="primary" onClick={() => navigate('/projects')}>
              Back to projects
            </Button>
          }
        />
      </div>
    );
  }

  const submitName = () => {
    const name = nameDraft.trim();
    if (name && name !== working.name) update((p) => ({ ...p, name }));
    setRenaming(false);
  };

  const tabs = [
    { to: '', label: 'Edit', end: true },
    { to: 'review', label: 'Review' },
    { to: 'export', label: 'Export' },
  ];

  const context: ProjectContext = {
    project: working,
    update,
    fps: projectFps(working, settings),
    selectedSegmentId,
    setSelectedSegmentId,
    pipeline,
  };

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-line bg-canvas px-6 pt-4 xl:px-8">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <IconButton label="Back to projects" size="md" variant="secondary" onClick={() => navigate('/projects')}>
            <IconArrowLeft size={17} />
          </IconButton>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12.5px] text-ink-3">
              {[working.clientName, working.presetName].filter(Boolean).join(' · ') || 'Project'}
            </p>
            {renaming ? (
              <input
                autoFocus
                aria-label="Project name"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={submitName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitName();
                  if (e.key === 'Escape') setRenaming(false);
                }}
                className="-ml-1.5 h-8 w-full max-w-[480px] rounded-[8px] border border-signal bg-surface-1 px-1.5 text-[19px] font-semibold tracking-[-0.02em] text-ink"
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setNameDraft(working.name);
                  setRenaming(true);
                }}
                className="group -ml-1.5 flex h-8 max-w-full items-center gap-2 rounded-[8px] px-1.5 text-left hover:bg-surface-2"
                title="Rename project"
              >
                <span className="truncate text-[19px] font-semibold tracking-[-0.02em] text-ink">{working.name}</span>
                <IconEdit size={14} className="shrink-0 text-ink-4 group-hover:text-ink-3" />
              </button>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Tooltip content="Undo (Ctrl+Z)">
              <IconButton label="Undo" size="md" disabled={past.current.length === 0} onClick={undo}>
                <IconUndo size={17} />
              </IconButton>
            </Tooltip>
            <Tooltip content="Redo (Ctrl+Shift+Z)">
              <IconButton label="Redo" size="md" disabled={future.current.length === 0} onClick={redo}>
                <IconRedo size={17} />
              </IconButton>
            </Tooltip>
            <Select
              aria-label="Project status"
              value={working.status}
              onChange={(e) => update((p) => ({ ...p, status: e.target.value as ProjectStatus }))}
              className="w-[148px]"
            >
              {projectStatuses.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
            {settings.autoSave ? (
              <span className="flex h-11 min-w-[92px] items-center justify-end gap-1.5 text-[12.5px] text-ink-3" aria-live="polite">
                {dirty || saveState === 'saving' ? (
                  'Saving…'
                ) : (
                  <>
                    <IconCheck size={14} /> Saved
                  </>
                )}
              </span>
            ) : (
              <Button variant={dirty ? 'primary' : 'secondary'} icon={<IconSave size={16} />} disabled={!dirty} onClick={() => commit().then(() => toast('Project saved'))}>
                {dirty ? 'Save' : 'Saved'}
              </Button>
            )}
          </div>
        </div>

        <nav aria-label="Project sections" className="mt-3 flex gap-1">
          {tabs.map((tab) => (
            <NavLink
              key={tab.label}
              to={tab.to}
              end={tab.end}
              className={({ isActive }) =>
                cn(
                  'relative flex h-11 items-center px-4 text-sm font-medium transition-colors',
                  isActive ? 'text-ink' : 'text-ink-3 hover:text-ink'
                )
              }
            >
              {({ isActive }) => (
                <>
                  {tab.label}
                  {isActive && <span className="absolute inset-x-3 -bottom-px h-[2px] rounded-full bg-signal" />}
                </>
              )}
            </NavLink>
          ))}
        </nav>
      </header>

      <div className="min-h-0 flex-1">
        <Outlet context={context} />
      </div>

      <UnsavedChangesGuard
        when={dirty && !settings.autoSave}
        title="Save changes to this project?"
        description="You have unsaved changes. Auto-save is turned off in Settings."
        onSave={commit}
        scope={`/projects/${working.id}`}
      />
    </div>
  );
}
