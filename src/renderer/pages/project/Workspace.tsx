import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useProject } from '../ProjectEditor';
import { VideoPlayerShell, type PlayerHandle } from '../../components/VideoPlayerShell';
import { SequenceTable } from '../../components/SequenceTable';
import { PipelineStatus } from '../../components/PipelineStatus';
import { DirectionPanel, SegmentInspector, SourcePanel } from './Inspector';
import { useProjectMedia } from './useProjectMedia';
import { createSegment, getSegments, mediaUrl, segmentAt } from '../../lib/project';
import { formatClock } from '../../lib/time';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  IconButton,
  Menu,
  SegmentedControl,
  Tooltip,
  cn,
  useToast,
} from '../../components/ui';
import { IconDownload, IconEye, IconFilm, IconInfo, IconMic, IconMore, IconPlay, IconPlus, IconScissors, IconSparkle, IconText, IconTrash, IconUpload } from '../../components/ui/icons';
import type { Segment, SegmentStatus } from '../../types';

type InspectorTab = 'segment' | 'direction' | 'source';
type Filter = 'all' | SegmentStatus;

const SPLIT_KEY = 'workspace.split';

function readSplit() {
  try {
    const v = parseFloat(localStorage.getItem(SPLIT_KEY) ?? '');
    return Number.isFinite(v) ? v : 0.5;
  } catch {
    return 0.5;
  }
}

function isTyping(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="radiogroup"]'));
}

export default function Workspace() {
  const { project, update, fps, selectedSegmentId, setSelectedSegmentId, pipeline } = useProject();
  const toast = useToast();
  const playerRef = useRef<PlayerHandle>(null);
  const instructionRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [playhead, setPlayhead] = useState(0);
  const [tab, setTab] = useState<InspectorTab>(project.source ? 'segment' : 'source');
  const [filter, setFilter] = useState<Filter>('all');
  const [split, setSplit] = useState(readSplit);
  const probeSource = pipeline.probeSource;
  const media = useProjectMedia(project, update, setSelectedSegmentId, useCallback(() => void probeSource(), [probeSource]));
  const [confirmTranscribe, setConfirmTranscribe] = useState(false);
  const [view, setView] = useState<'source' | 'preview'>('source');
  const [previewExists, setPreviewExists] = useState(false);
  const previewPath = project.render?.previewPath;

  useEffect(() => {
    if (!previewPath || !window.electronAPI) {
      setPreviewExists(false);
      return;
    }
    window.electronAPI.fileExists(previewPath).then(setPreviewExists);
  }, [previewPath]);

  // Show the new preview as soon as a render finishes.
  const renderedAt = project.render?.renderedAt;
  useEffect(() => {
    if (renderedAt) setView('preview');
  }, [renderedAt]);

  const showingPreview = view === 'preview' && previewExists && Boolean(previewPath);
  const busy = Boolean(pipeline.job);

  const segments = useMemo(() => getSegments(project), [project]);
  const hasTranscript = segments.some((s) => s.transcript.trim());
  const approvedGraphics = segments.filter((s) => s.status === 'approved' && s.plan).length;

  const transcribe = () => {
    if (segments.length) setConfirmTranscribe(true);
    else void pipeline.transcribe();
  };
  const numbering = useMemo(() => new Map(segments.map((s, i) => [s.id, i + 1])), [segments]);
  const visible = filter === 'all' ? segments : segments.filter((s) => s.status === filter);
  const selectedIndex = segments.findIndex((s) => s.id === selectedSegmentId);
  const selected = selectedIndex >= 0 ? segments[selectedIndex] : null;
  const active = project.source ? segmentAt(segments, playhead) : undefined;
  const duration = project.source?.duration ?? 0;
  const totalPlanned = segments.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);

  const patchSegment = useCallback(
    (id: string, patch: Partial<Segment>) =>
      update((p) => ({
        ...p,
        // A start the editor sets by hand is theirs: the transcription's "not verified" mark goes.
        segments: (p.segments ?? []).map((s) => (s.id === id ? { ...s, ...patch, ...(patch.start !== undefined ? { startUncertain: undefined } : {}) } : s)),
      })),
    [update]
  );

  const select = useCallback(
    (segment: Segment | undefined) => {
      if (!segment) return;
      setSelectedSegmentId(segment.id);
      setTab('segment');
    },
    [setSelectedSegmentId]
  );

  const addSegment = useCallback(() => {
    const hasMedia = Boolean(project.source && duration);
    let start: number;
    if (hasMedia) start = playhead;
    else start = segments.length ? segments[segments.length - 1].end : 0;
    const next = segments.find((s) => s.start > start + 0.001);
    let end = Math.min(start + 3, next ? next.start : Infinity);
    if (hasMedia) end = Math.min(end, duration);
    if (end - start < 0.1) end = start + 3;
    const segment = createSegment(start, end);
    update((p) => ({ ...p, segments: [...(p.segments ?? []), segment] }));
    select(segment);
    window.setTimeout(() => instructionRef.current?.focus(), 50);
  }, [project.source, duration, playhead, segments, update, select]);

  const splitTarget = active ?? selected;
  const canSplit = Boolean(project.source && splitTarget && playhead > splitTarget.start + 0.05 && playhead < splitTarget.end - 0.05);

  const splitAtPlayhead = useCallback(() => {
    if (!canSplit || !splitTarget) return;
    const second = createSegment(playhead, splitTarget.end, { visualMode: splitTarget.visualMode, status: 'pending' });
    update((p) => ({
      ...p,
      segments: [...(p.segments ?? []).map((s) => (s.id === splitTarget.id ? { ...s, end: playhead } : s)), second],
    }));
    select(second);
  }, [canSplit, splitTarget, playhead, update, select]);

  const deleteSelected = useCallback(() => {
    if (!selected) return;
    const neighbour = segments[selectedIndex + 1] ?? segments[selectedIndex - 1];
    update((p) => ({ ...p, segments: (p.segments ?? []).filter((s) => s.id !== selected.id) }));
    setSelectedSegmentId(neighbour?.id ?? null);
    toast('Segment deleted', { tone: 'info', description: 'Press Ctrl+Z to undo.' });
  }, [selected, selectedIndex, segments, update, setSelectedSegmentId, toast]);

  const move = useCallback(
    (dir: 1 | -1) => {
      const target = segments[(selectedIndex < 0 ? (dir === 1 ? -1 : segments.length) : selectedIndex) + dir];
      if (target) {
        select(target);
        playerRef.current?.seek(target.start);
      }
    },
    [segments, selectedIndex, select]
  );

  // NLE-style shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      const player = playerRef.current;
      switch (e.key) {
        case ' ':
        case 'k':
        case 'K':
          if (e.key === ' ' && e.target instanceof Element && e.target.closest('button')) return;
          e.preventDefault();
          if (e.key === ' ') player?.togglePlay();
          else player?.pause();
          break;
        case 'j':
        case 'J':
          player?.nudge(-5);
          break;
        case 'l':
        case 'L':
          player?.nudge(5);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (e.shiftKey) player?.nudge(-1);
          else player?.step(-1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (e.shiftKey) player?.nudge(1);
          else player?.step(1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          move(-1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          move(1);
          break;
        case 'n':
        case 'N':
          e.preventDefault();
          addSegment();
          break;
        case 's':
        case 'S':
          e.preventDefault();
          splitAtPlayhead();
          break;
        case 'i':
        case 'I':
          if (selected && project.source) patchSegment(selected.id, { start: Math.min(playhead, selected.end) });
          break;
        case 'o':
        case 'O':
          if (selected && project.source) patchSegment(selected.id, { end: Math.max(playhead, selected.start) });
          break;
        case 'Delete':
        case 'Backspace':
          if (selected) {
            e.preventDefault();
            deleteSelected();
          }
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [move, addSegment, splitAtPlayhead, deleteSelected, selected, playhead, patchSegment, project.source]);

  // Resizable split between the viewer row and the sequence
  const startResize = (e: React.PointerEvent) => {
    const container = containerRef.current;
    if (!container) return;
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const onMove = (ev: PointerEvent) => {
      const ratio = (ev.clientY - rect.top) / rect.height;
      setSplit(Math.max(0.3, Math.min(0.72, ratio)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setSplit((v) => {
        try {
          localStorage.setItem(SPLIT_KEY, String(v));
        } catch {
          // optional preference
        }
        return v;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col px-4 pt-4 pb-4 xl:px-5">
      {/* Viewer + inspector */}
      <div
        className="grid min-h-[280px] shrink-0 grid-cols-[minmax(0,1fr)_minmax(340px,380px)] gap-4 2xl:grid-cols-[minmax(0,1fr)_440px]"
        style={{ height: `${split * 100}%` }}
      >
        <div className="relative h-full min-h-0">
        {previewExists && project.source && (
          <div className="absolute top-3 left-3 z-10">
            <SegmentedControl<'source' | 'preview'>
              label="Viewer"
              size="sm"
              value={showingPreview ? 'preview' : 'source'}
              onChange={setView}
              options={[
                { value: 'source', label: 'Source' },
                { value: 'preview', label: 'Rendered preview' },
              ]}
            />
          </div>
        )}
        <VideoPlayerShell
          ref={playerRef}
          src={showingPreview ? mediaUrl(previewPath!) : project.source ? mediaUrl(project.source.path) : null}
          fps={fps}
          segments={segments}
          comments={project.comments}
          selectedSegmentId={selectedSegmentId}
          onTimeChange={setPlayhead}
          onDuration={media.recordDuration}
          empty={
            <EmptyState
              compact
              className="border-none"
              icon={<IconFilm size={22} />}
              title="No source media"
              description="Add the video you are cutting to preview it, set in/out points from the playhead and review segments."
              action={
                <Button variant="primary" icon={<IconUpload size={16} />} onClick={media.chooseSource} disabled={!window.electronAPI}>
                  Choose video…
                </Button>
              }
            />
          }
        />
        </div>

        <aside className="flex min-h-0 flex-col overflow-hidden rounded-[14px] border border-line bg-surface-2">
          <div className="shrink-0 border-b border-line p-2.5">
            <SegmentedControl<InspectorTab>
              label="Inspector"
              size="sm"
              fullWidth
              value={tab}
              onChange={setTab}
              options={[
                { value: 'segment', label: 'Segment' },
                { value: 'direction', label: 'Direction' },
                { value: 'source', label: 'Source' },
              ]}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === 'segment' && (
              <SegmentInspector
                segment={selected}
                index={selectedIndex}
                total={segments.length}
                fps={fps}
                videoDuration={project.source?.duration ?? 0}
                canUsePlayhead={Boolean(project.source)}
                playhead={playhead}
                instructionRef={instructionRef}
                onChange={(patch) => selected && patchSegment(selected.id, patch)}
                onDelete={deleteSelected}
                onSplit={splitAtPlayhead}
                canSplit={canSplit}
                onPrev={() => move(-1)}
                onNext={() => move(1)}
                pipeline={pipeline}
                buildResult={selected ? project.render?.segments.find((r) => r.segmentId === selected.id) : undefined}
              />
            )}
            {tab === 'direction' && (
              <DirectionPanel
                project={project}
                onNotes={(creativeNotes) => update((p) => ({ ...p, creativeNotes }))}
                onVariety={(variety) => update((p) => ({ ...p, planning: { ...(p.planning ?? {}), variety } }))}
              />
            )}
            {tab === 'source' && (
              <SourcePanel
                project={project}
                onChooseSource={media.chooseSource}
                onRemoveSource={media.removeSource}
                onImportCaptions={media.importCaptions}
                onTranscribe={transcribe}
                busy={busy}
              />
            )}
          </div>
        </aside>
      </div>

      {/* Resize handle */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize viewer and sequence"
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            e.stopPropagation();
            setSplit((v) => Math.max(0.3, Math.min(0.72, v + (e.key === 'ArrowDown' ? 0.03 : -0.03))));
          }
        }}
        className="group flex h-4 shrink-0 cursor-row-resize items-center justify-center"
      >
        <span className="h-1 w-10 rounded-full bg-line-strong transition-colors group-hover:bg-ink-4 group-focus-visible:bg-signal" />
      </div>

      {/* Sequence */}
      <section aria-label="Sequence" className="flex min-h-[200px] flex-1 flex-col overflow-hidden rounded-[14px] border border-line bg-surface-1">
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2.5">
          <div className="flex items-baseline gap-3">
            <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">Sequence</h2>
            <span className="timecode text-[12.5px] text-ink-3">
              {segments.length} seg · {formatClock(totalPlanned)}
              {duration ? ` of ${formatClock(duration)}` : ''}
            </span>
          </div>
          {segments.length > 0 && (
            <SegmentedControl<Filter>
              label="Filter segments"
              size="sm"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'All' },
                { value: 'pending', label: 'Pending' },
                { value: 'needs-revision', label: 'Needs revision' },
                { value: 'approved', label: 'Approved' },
              ]}
            />
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" icon={<IconMic size={15} />} disabled={!project.source || busy || !window.electronAPI} onClick={transcribe}>
              Transcribe
            </Button>
            <Button size="sm" variant="secondary" icon={<IconSparkle size={15} />} disabled={!hasTranscript || busy || !window.electronAPI} onClick={() => void pipeline.suggest()}>
              Suggest visuals
            </Button>
            <Tooltip content={approvedGraphics ? `Render ${approvedGraphics} approved graphic(s) over the source` : 'Approve suggestions to render them'}>
              <span tabIndex={approvedGraphics ? -1 : 0}>
                <Button size="sm" variant="secondary" icon={<IconPlay size={15} />} disabled={!project.source || !approvedGraphics || busy || !window.electronAPI} onClick={() => void pipeline.renderPreview()}>
                  Render preview
                </Button>
              </span>
            </Tooltip>
            <Tooltip
              content={
                <span className="flex flex-col gap-1">
                  <span>Space play/pause · J/L ±5s · ←/→ frame</span>
                  <span>↑/↓ segment · N new · S split · I/O set in/out</span>
                  <span>Del delete · Ctrl+Z undo · Ctrl+S save</span>
                </span>
              }
            >
              <span tabIndex={0} className="flex h-9 items-center gap-1.5 rounded-full px-2 text-[12.5px] text-ink-3 hover:text-ink-2">
                <IconInfo size={15} /> <span className="hidden xl:inline">Shortcuts</span>
              </span>
            </Tooltip>
            <Button size="sm" variant="secondary" icon={<IconScissors size={15} />} disabled={!canSplit} onClick={splitAtPlayhead}>
              Split
            </Button>
            <Button size="sm" variant="primary" icon={<IconPlus size={16} />} onClick={addSegment}>
              Add segment
            </Button>
            <Menu
              items={[
                { label: 'Import captions (SRT, VTT, TXT)…', icon: <IconUpload size={16} />, onSelect: media.importCaptions, disabled: !window.electronAPI },
                { label: 'Export plan as CSV…', icon: <IconDownload size={16} />, onSelect: media.exportCsv, disabled: !segments.length || !window.electronAPI },
                { label: 'Export captions as SRT…', icon: <IconText size={16} />, onSelect: media.exportSrt, disabled: !segments.length || !window.electronAPI },
                'divider',
                { label: 'Clear sequence…', icon: <IconTrash size={16} />, danger: true, onSelect: media.askClear, disabled: !segments.length },
              ]}
              trigger={(props) => (
                <IconButton label="More sequence actions" size="md" variant="secondary" {...props}>
                  <IconMore size={18} />
                </IconButton>
              )}
            />
          </div>
        </div>

        {(pipeline.job || pipeline.error || pipeline.notice) && <PipelineStatus pipeline={pipeline} className="m-3 mb-0 shrink-0" />}

        <div className={cn('min-h-0 flex-1 overflow-auto', segments.length === 0 && 'flex items-center justify-center')}>
          {segments.length === 0 ? (
            <EmptyState
              compact
              className="m-4 w-full max-w-xl"
              icon={<IconText size={20} />}
              title="Build your sequence"
              description={
                project.source
                  ? 'Transcribe the source locally to get one timed segment per sentence, import an SRT or VTT file, or add segments at the playhead.'
                  : 'Import an SRT or VTT transcript to create timed segments, or add them one by one at the playhead.'
              }
              action={
                <>
                  {project.source && (
                    <Button variant="primary" icon={<IconMic size={16} />} onClick={transcribe} disabled={busy || !window.electronAPI}>
                      Transcribe source
                    </Button>
                  )}
                  <Button variant={project.source ? 'secondary' : 'primary'} icon={<IconPlus size={16} />} onClick={addSegment}>
                    Add segment
                  </Button>
                  <Button variant="secondary" icon={<IconUpload size={16} />} onClick={media.importCaptions} disabled={!window.electronAPI}>
                    Import captions…
                  </Button>
                </>
              }
            />
          ) : visible.length === 0 ? (
            <p className="p-8 text-center text-[13.5px] text-ink-3">No segments with this status.</p>
          ) : (
            <SequenceTable
              segments={visible}
              numbering={numbering}
              fps={fps}
              selectedId={selectedSegmentId}
              activeId={active?.id}
              onSelect={select}
              onSeek={(t) => playerRef.current?.seek(t)}
              onEdit={(s) => {
                select(s);
                playerRef.current?.seek(s.start);
                window.setTimeout(() => instructionRef.current?.focus(), 30);
              }}
            />
          )}
        </div>
      </section>
      {media.dialogs}
      <ConfirmDialog
        open={confirmTranscribe}
        title="Replace the sequence with a new transcript?"
        description="Transcription creates one segment per sentence. The current segments, their instructions, statuses and plans are replaced. You can undo with Ctrl+Z while the project is open. A file that was transcribed before is not transcribed again."
        confirmLabel="Transcribe and replace"
        destructive
        onCancel={() => setConfirmTranscribe(false)}
        onConfirm={() => {
          setConfirmTranscribe(false);
          void pipeline.transcribe();
        }}
      />
    </div>
  );
}
