// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Preset } from '../../src/renderer/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stored: Preset = {
  id: 'stored',
  name: 'Stored preset',
  clientName: '',
  type: 'custom',
  referenceLinks: [],
  referenceFiles: [],
  creativeBrief: '',
  fonts: '',
  tracking: '',
  logoPath: '',
  brandingNotes: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

afterEach(() => {
  delete (window as { electronAPI?: unknown }).electronAPI;
  vi.resetModules();
});

describe('DataProvider', () => {
  it('does not overwrite stored data when a save is requested before loading finishes', async () => {
    let finishLoad!: () => void;
    const loadGate = new Promise<void>((r) => (finishLoad = r));
    const savePresets = vi.fn().mockResolvedValue(true);
    (window as { electronAPI?: unknown }).electronAPI = {
      loadPresets: () => loadGate.then(() => [stored]),
      loadProjects: () => loadGate.then(() => []),
      loadSettings: () => loadGate.then(() => ({})),
      savePresets,
      saveProjects: vi.fn().mockResolvedValue(true),
      saveSettings: vi.fn().mockResolvedValue(true),
    };
    // The module captures window.electronAPI at import time.
    const { DataProvider, useData } = await import('../../src/renderer/state/DataProvider');

    function EarlySaver() {
      const { savePresets: save } = useData();
      useEffect(() => {
        void save((current) => [...current, { ...stored, id: 'new', name: 'New preset' }]);
      }, [save]);
      return null;
    }

    const root = createRoot(document.createElement('div'));
    await act(async () => {
      root.render(
        <DataProvider>
          <EarlySaver />
        </DataProvider>
      );
    });
    expect(savePresets).not.toHaveBeenCalled();

    await act(async () => {
      finishLoad();
      await loadGate;
    });
    expect(savePresets).toHaveBeenCalledTimes(1);
    expect(savePresets.mock.calls[0][0].map((p: Preset) => p.id)).toEqual(['stored', 'new']);
    await act(async () => root.unmount());
  });
});
