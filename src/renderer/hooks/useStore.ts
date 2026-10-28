import { useData } from '../state/DataProvider';

// Thin hooks over the shared DataProvider so every screen sees the same, single source of truth.

export function usePresets() {
  const { presets, savePresets, loading } = useData();
  return { presets, save: savePresets, loading };
}

export function useProjects() {
  const { projects, saveProjects, updateProject, loading } = useData();
  return { projects, save: saveProjects, updateProject, loading };
}

export function useSettings() {
  const { settings, saveSettings, loading } = useData();
  return { settings, save: saveSettings, loading };
}
