import { useCallback, useState } from 'react';
import { parseCaptions, segmentsToCsv, segmentsToSrt, type CaptionCue } from '../../lib/captions';
import { createSegment, fileName, getSegments } from '../../lib/project';
import { Button, ConfirmDialog, Modal, useToast } from '../../components/ui';
import type { Project } from '../../types';

/** Source media, caption import/export and sequence-level actions for the Edit workspace. */
export function useProjectMedia(project: Project, update: (fn: (p: Project) => Project) => void, setSelected: (id: string | null) => void) {
  const toast = useToast();
  const api = window.electronAPI;
  const [pendingCues, setPendingCues] = useState<{ cues: CaptionCue[]; file: string; untimed: boolean } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const chooseSource = useCallback(async () => {
    if (!api) return;
    const [file] = await api.openFiles({ kind: 'video', title: 'Choose source video' });
    if (!file) return;
    update((p) => ({ ...p, source: { path: file, name: fileName(file) } }));
    toast('Source media linked', { description: fileName(file) });
  }, [api, update, toast]);

  const removeSource = useCallback(() => {
    update((p) => ({ ...p, source: null }));
  }, [update]);

  const recordDuration = useCallback(
    (duration: number) => {
      if (project.source && Math.abs((project.source.duration ?? 0) - duration) > 0.01) {
        update((p) => (p.source ? { ...p, source: { ...p.source, duration } } : p));
      }
    },
    [project.source, update]
  );

  const applyCues = (mode: 'replace' | 'append') => {
    if (!pendingCues) return;
    const existing = getSegments(project);
    const offset = mode === 'append' && existing.length ? existing[existing.length - 1].end : 0;
    const created = pendingCues.cues.map((c) => createSegment(c.start + offset, c.end + offset, { transcript: c.text }));
    update((p) => ({ ...p, segments: mode === 'replace' ? created : [...(p.segments ?? []), ...created] }));
    setSelected(created[0]?.id ?? null);
    toast(`Imported ${created.length} segments`, {
      description: pendingCues.untimed ? 'Plain text has no timing — each paragraph got a 5-second placeholder. Adjust in/out points.' : pendingCues.file,
      tone: pendingCues.untimed ? 'info' : 'success',
    });
    setPendingCues(null);
  };

  const importCaptions = useCallback(async () => {
    if (!api) return;
    const [file] = await api.openFiles({ kind: 'captions', title: 'Import captions or transcript' });
    if (!file) return;
    try {
      const text = await api.readTextFile(file);
      const cues = parseCaptions(text);
      if (cues.length === 0) {
        toast('No captions found', { tone: 'error', description: 'The file did not contain any readable cues.' });
        return;
      }
      const untimed = /\.txt$/i.test(file);
      if ((project.segments ?? []).length === 0) {
        const created = cues.map((c) => createSegment(c.start, c.end, { transcript: c.text }));
        update((p) => ({ ...p, segments: created }));
        setSelected(created[0]?.id ?? null);
        toast(`Imported ${created.length} segments`, {
          description: untimed ? 'Plain text has no timing — each paragraph got a 5-second placeholder. Adjust in/out points.' : fileName(file),
          tone: untimed ? 'info' : 'success',
        });
      } else {
        setPendingCues({ cues, file: fileName(file), untimed });
      }
    } catch (err) {
      toast('Could not import file', { tone: 'error', description: err instanceof Error ? err.message : String(err) });
    }
  }, [api, project.segments, update, setSelected, toast]);

  const exportText = async (content: string, ext: string, label: string) => {
    if (!api) return;
    try {
      const saved = await api.saveTextFile({
        defaultPath: `${project.name.replace(/[\\/:*?"<>|]+/g, '')}.${ext}`,
        content,
        extensions: [ext],
        name: label,
      });
      if (saved) toast(`${label} exported`, { description: saved });
    } catch (err) {
      toast('Export failed', { tone: 'error', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const exportCsv = () => exportText(segmentsToCsv(getSegments(project)), 'csv', 'Edit plan');
  const exportSrt = () => {
    const srt = segmentsToSrt(getSegments(project));
    if (!srt.trim()) {
      toast('Nothing to export', { tone: 'info', description: 'No segment has a transcript yet.' });
      return;
    }
    exportText(srt, 'srt', 'Captions');
  };

  const dialogs = (
    <>
      <Modal
        open={Boolean(pendingCues)}
        onClose={() => setPendingCues(null)}
        title="Import captions"
        description={pendingCues ? `${pendingCues.file} contains ${pendingCues.cues.length} cues. This project already has ${(project.segments ?? []).length} segments.` : undefined}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingCues(null)}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={() => applyCues('append')}>
              Append
            </Button>
            <Button variant="primary" onClick={() => applyCues('replace')}>
              Replace sequence
            </Button>
          </>
        }
      />
      <ConfirmDialog
        open={confirmClear}
        title="Clear the whole sequence?"
        description="All segments, instructions and statuses in this project will be removed. You can undo with Ctrl+Z while the project is open."
        confirmLabel="Clear sequence"
        destructive
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          update((p) => ({ ...p, segments: [] }));
          setSelected(null);
          setConfirmClear(false);
        }}
      />
    </>
  );

  return { chooseSource, removeSource, recordDuration, importCaptions, exportCsv, exportSrt, askClear: () => setConfirmClear(true), dialogs };
}
