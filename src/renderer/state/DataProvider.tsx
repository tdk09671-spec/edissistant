import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppSettings, Preset, Project } from '../types';

const api = typeof window !== 'undefined' ? window.electronAPI : undefined;

// Fallback localStorage for running the renderer in a plain browser (no Electron)
function localGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function localSet(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable
  }
}

export const defaultSettings: AppSettings = {
  theme: 'dark',
  ffmpegPath: '',
  outputDirectory: '',
  autoSave: true,
  confirmBeforeDelete: true,
  reduceMotion: false,
  hardwareAcceleration: true,
  defaultResolution: '1920x1080',
  defaultFrameRate: '25',
  localAI: {
    enabled: false,
    provider: 'ollama',
    endpoint: 'http://localhost:11434',
    model: '',
  },
};

function mergeSettings(loaded: Partial<AppSettings> | null | undefined): AppSettings {
  const { claudeApiKey: _legacy, ...rest } = (loaded ?? {}) as Partial<AppSettings> & { claudeApiKey?: string };
  return { ...defaultSettings, ...rest, localAI: { ...defaultSettings.localAI, ...(rest.localAI ?? {}) } };
}

type Updater<T> = T | ((current: T) => T);

interface DataContextValue {
  presets: Preset[];
  projects: Project[];
  settings: AppSettings;
  loading: boolean;
  saveError: string | null;
  savePresets: (updater: Updater<Preset[]>) => Promise<void>;
  saveProjects: (updater: Updater<Project[]>) => Promise<void>;
  saveSettings: (updater: Updater<AppSettings>) => Promise<void>;
  updateProject: (id: string, updater: (project: Project) => Project) => Promise<void>;
}

const DataContext = createContext<DataContextValue | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [loading, setLoading] = useState(true);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Refs hold the latest values so consecutive updates compose instead of overwriting each other.
  const presetsRef = useRef(presets);
  const projectsRef = useRef(projects);
  const settingsRef = useRef(settings);

  useEffect(() => {
    (async () => {
      const [loadedPresets, loadedProjects, loadedSettings] = await Promise.all([
        api?.loadPresets ? api.loadPresets().catch(() => localGet<Preset[]>('presets', [])) : localGet<Preset[]>('presets', []),
        api?.loadProjects ? api.loadProjects().catch(() => localGet<Project[]>('projects', [])) : localGet<Project[]>('projects', []),
        api?.loadSettings ? api.loadSettings().catch(() => localGet('settings', {})) : localGet('settings', {}),
      ]);
      presetsRef.current = Array.isArray(loadedPresets) ? loadedPresets : [];
      projectsRef.current = Array.isArray(loadedProjects) ? loadedProjects : [];
      settingsRef.current = mergeSettings(loadedSettings as Partial<AppSettings>);
      setPresets(presetsRef.current);
      setProjects(projectsRef.current);
      setSettings(settingsRef.current);
      setLoading(false);
    })();
  }, []);

  const persist = useCallback(async (key: 'presets' | 'projects' | 'settings', value: unknown) => {
    try {
      if (key === 'presets' && api?.savePresets) await api.savePresets(value as Preset[]);
      else if (key === 'projects' && api?.saveProjects) await api.saveProjects(value as Project[]);
      else if (key === 'settings' && api?.saveSettings) await api.saveSettings(value as AppSettings);
      else localSet(key, value);
      setSaveError(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save changes');
      localSet(key, value);
    }
  }, []);

  const savePresets = useCallback(
    async (updater: Updater<Preset[]>) => {
      const next = typeof updater === 'function' ? updater(presetsRef.current) : updater;
      presetsRef.current = next.filter((p) => !p.builtIn);
      setPresets(presetsRef.current);
      await persist('presets', presetsRef.current);
    },
    [persist]
  );

  const saveProjects = useCallback(
    async (updater: Updater<Project[]>) => {
      const next = typeof updater === 'function' ? updater(projectsRef.current) : updater;
      projectsRef.current = next;
      setProjects(next);
      await persist('projects', next);
    },
    [persist]
  );

  const saveSettings = useCallback(
    async (updater: Updater<AppSettings>) => {
      const next = typeof updater === 'function' ? updater(settingsRef.current) : updater;
      settingsRef.current = next;
      setSettings(next);
      await persist('settings', next);
    },
    [persist]
  );

  const updateProject = useCallback(
    (id: string, updater: (project: Project) => Project) =>
      saveProjects((all) => all.map((p) => (p.id === id ? { ...updater(p), updatedAt: new Date().toISOString() } : p))),
    [saveProjects]
  );

  const value = useMemo(
    () => ({ presets, projects, settings, loading, saveError, savePresets, saveProjects, saveSettings, updateProject }),
    [presets, projects, settings, loading, saveError, savePresets, saveProjects, saveSettings, updateProject]
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataContextValue {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData must be used inside DataProvider');
  return ctx;
}
