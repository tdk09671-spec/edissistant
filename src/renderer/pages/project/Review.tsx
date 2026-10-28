import { useEffect, useMemo, useRef, useState } from 'react';
import { v4 as uuid } from 'uuid';
import { useProject } from '../ProjectEditor';
import { VideoPlayerShell, type PlayerHandle } from '../../components/VideoPlayerShell';
import { CommentPanel } from '../../components/CommentPanel';
import { getSegments, mediaUrl, segmentAt } from '../../lib/project';
import { segmentStatuses, segmentStatusInfo, visualModeInfo } from '../../lib/catalog';
import { formatDateTime, formatTimecode } from '../../lib/time';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  Modal,
  SegmentedControl,
  Textarea,
  Tooltip,
  UnavailableBadge,
  cn,
  useToast,
} from '../../components/ui';
import { IconFilm, IconHistory, IconRefresh, IconSave, IconTrash } from '../../components/ui/icons';
import type { ProjectVersion, ReviewComment, SegmentStatus } from '../../types';

type PanelTab = 'comments' | 'versions';

export default function Review() {
  const { project, update, fps, selectedSegmentId, setSelectedSegmentId } = useProject();
  const toast = useToast();
  const playerRef = useRef<PlayerHandle>(null);
  const [playhead, setPlayhead] = useState(0);
  const [panel, setPanel] = useState<PanelTab>('comments');
  const [versionModal, setVersionModal] = useState(false);
  const [versionLabel, setVersionLabel] = useState('');
  const [versionNote, setVersionNote] = useState('');
  const [restoring, setRestoring] = useState<ProjectVersion | null>(null);

  const segments = useMemo(() => getSegments(project), [project]);
  const comments = project.comments ?? [];
  const versions = [...(project.versions ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const duration = project.source?.duration ?? 0;
  const active = segmentAt(segments, playhead);
  const focused = segments.find((s) => s.id === selectedSegmentId) ?? active ?? null;
  const focusedIndex = focused ? segments.indexOf(focused) : -1;

  const approved = segments.filter((s) => s.status === 'approved').length;
  const revisions = segments.filter((s) => s.status === 'needs-revision').length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target instanceof Element ? e.target : document.body;
      if (target.closest('input, textarea, select, [role="dialog"], [role="menu"]')) return;
      const player = playerRef.current;
      if (e.key === ' ' && !target.closest('button')) {
        e.preventDefault();
        player?.togglePlay();
      } else if (e.key === 'k' || e.key === 'K') player?.pause();
      else if (e.key === 'j' || e.key === 'J') player?.nudge(-5);
      else if (e.key === 'l' || e.key === 'L') player?.nudge(5);
      else if (e.key === 'ArrowLeft' && !target.closest('[role="radiogroup"]')) {
        e.preventDefault();
        player?.step(-1);
      } else if (e.key === 'ArrowRight' && !target.closest('[role="radiogroup"]')) {
        e.preventDefault();
        player?.step(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const setStatus = (id: string, status: SegmentStatus) =>
    update((p) => ({ ...p, segments: (p.segments ?? []).map((s) => (s.id === id ? { ...s, status } : s)) }));

  const addComment = (text: string, markForRevision: boolean) => {
    const time = playerRef.current?.getTime() ?? playhead;
    const seg = segmentAt(segments, time) ?? null;
    const comment: ReviewComment = { id: uuid(), time, segmentId: seg?.id ?? null, text, resolved: false, createdAt: new Date().toISOString() };
    update((p) => ({
      ...p,
      comments: [...(p.comments ?? []), comment],
      segments: markForRevision && seg ? (p.segments ?? []).map((s) => (s.id === seg.id ? { ...s, status: 'needs-revision' } : s)) : p.segments,
    }));
  };

  const saveVersion = () => {
    const version: ProjectVersion = {
      id: uuid(),
      label: versionLabel.trim() || `Version ${(project.versions?.length ?? 0) + 1}`,
      note: versionNote.trim(),
      createdAt: new Date().toISOString(),
      segments: structuredClone(project.segments ?? []),
    };
    update((p) => ({ ...p, versions: [...(p.versions ?? []), version] }));
    setVersionModal(false);
    setVersionLabel('');
    setVersionNote('');
    toast('Version saved', { description: version.label });
  };

  const restoreVersion = (version: ProjectVersion) => {
    const backup: ProjectVersion = {
      id: uuid(),
      label: `Before restoring “${version.label}”`,
      note: 'Saved automatically',
      createdAt: new Date().toISOString(),
      segments: structuredClone(project.segments ?? []),
    };
    update((p) => ({ ...p, segments: structuredClone(version.segments), versions: [...(p.versions ?? []), backup] }));
    setRestoring(null);
    toast('Version restored', { description: 'Your previous sequence was saved as a version.' });
  };

  if (!project.source) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <EmptyState
          icon={<IconFilm size={22} />}
          title="Nothing to review yet"
          description="Link the source video in the Edit tab. Review plays it back against your segments so you can leave timestamped notes."
        />
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_minmax(340px,380px)] gap-4 p-4 xl:p-5 2xl:grid-cols-[minmax(0,1fr)_420px]">
      {/* Player column */}
      <div className="flex min-h-0 flex-col gap-4">
        <div className="min-h-[240px] flex-1">
          <VideoPlayerShell
            ref={playerRef}
            size="large"
            src={mediaUrl(project.source.path)}
            fps={fps}
            segments={segments}
            comments={comments}
            selectedSegmentId={focused?.id}
            onTimeChange={setPlayhead}
          />
        </div>

        {/* Segment strip */}
        <div className="shrink-0 rounded-[14px] border border-line bg-surface-1 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[13px] text-ink-2">
              <span className="timecode text-ink">{approved}</span> of <span className="timecode text-ink">{segments.length}</span> approved
              {revisions > 0 && (
                <>
                  {' · '}
                  <span className="timecode text-warning">{revisions}</span> need revision
                </>
              )}
            </p>
            <div className="flex items-center gap-3 text-[12px] text-ink-3">
              {segmentStatuses.map((s) => (
                <span key={s.value} className="flex items-center gap-1.5">
                  <span className={cn('size-2 rounded-full', s.value === 'approved' ? 'bg-success' : s.value === 'needs-revision' ? 'bg-warning' : 'bg-ink-4')} />
                  {s.label}
                </span>
              ))}
            </div>
          </div>
          {segments.length === 0 ? (
            <p className="mt-3 text-[13px] text-ink-3">Add segments in the Edit tab to review them one by one.</p>
          ) : (
            <div className="relative mt-3 h-9 overflow-hidden rounded-[8px] bg-surface-3" role="list" aria-label="Segments">
              {segments.map((s, i) => {
                const left = duration ? (s.start / duration) * 100 : (i / segments.length) * 100;
                const width = duration ? ((s.end - s.start) / duration) * 100 : 100 / segments.length;
                return (
                  <button
                    key={s.id}
                    type="button"
                    role="listitem"
                    title={`Segment ${i + 1} · ${segmentStatusInfo(s.status).label}`}
                    onClick={() => {
                      setSelectedSegmentId(s.id);
                      playerRef.current?.seek(s.start);
                    }}
                    className={cn(
                      'absolute inset-y-0 border-r-2 border-surface-1 transition-[filter] hover:brightness-125',
                      s.status === 'approved' ? 'bg-success/55' : s.status === 'needs-revision' ? 'bg-warning/60' : 'bg-surface-4',
                      focused?.id === s.id && 'shadow-[inset_0_0_0_2px_var(--color-ink)]'
                    )}
                    style={{ left: `${left}%`, width: `${Math.max(width, 0.4)}%` }}
                  />
                );
              })}
              {duration > 0 && <div className="pointer-events-none absolute inset-y-0 w-[2px] bg-ink" style={{ left: `${(playhead / duration) * 100}%` }} />}
            </div>
          )}

          {focused && (
            <div className="mt-4 flex flex-wrap items-start gap-x-6 gap-y-4 border-t border-line pt-4">
              <div className="min-w-[200px] flex-1">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="timecode text-[13px] text-ink">Segment {String(focusedIndex + 1).padStart(2, '0')}</span>
                  <span className="timecode text-[12.5px] text-ink-3">
                    {formatTimecode(focused.start, fps)} – {formatTimecode(focused.end, fps)}
                  </span>
                  <span className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
                    <span className="size-2 rounded-full" style={{ background: visualModeInfo(focused.visualMode).color }} />
                    {visualModeInfo(focused.visualMode).label}
                  </span>
                </div>
                <p className={cn('mt-2 line-clamp-2 text-[13.5px] leading-relaxed', focused.instruction ? 'text-ink-2' : 'text-ink-4')}>
                  {focused.instruction || 'No editor instruction.'}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <SegmentedControl<SegmentStatus>
                  label="Revision status"
                  size="sm"
                  value={focused.status}
                  onChange={(status) => setStatus(focused.id, status)}
                  options={segmentStatuses.map((s) => ({ value: s.value, label: s.label }))}
                />
                <Tooltip content="Re-rendering a segment needs the render engine, which isn’t part of this build yet.">
                  <span tabIndex={0}>
                    <Button size="sm" variant="secondary" icon={<IconRefresh size={15} />} disabled>
                      Regenerate
                    </Button>
                  </span>
                </Tooltip>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Side panel */}
      <aside className="flex min-h-0 flex-col overflow-hidden rounded-[14px] border border-line bg-surface-1">
        <div className="shrink-0 border-b border-line p-2.5">
          <SegmentedControl<PanelTab>
            label="Review panel"
            size="sm"
            fullWidth
            value={panel}
            onChange={setPanel}
            options={[
              { value: 'comments', label: `Comments${comments.length ? ` · ${comments.filter((c) => !c.resolved).length}` : ''}` },
              { value: 'versions', label: `Versions${versions.length ? ` · ${versions.length}` : ''}` },
            ]}
          />
        </div>
        <div className="min-h-0 flex-1">
          {panel === 'comments' ? (
            <CommentPanel
              comments={comments}
              segments={segments}
              fps={fps}
              playhead={playhead}
              onComposerFocus={() => playerRef.current?.pause()}
              onAdd={addComment}
              onToggleResolved={(id) => update((p) => ({ ...p, comments: (p.comments ?? []).map((c) => (c.id === id ? { ...c, resolved: !c.resolved } : c)) }))}
              onDelete={(id) => update((p) => ({ ...p, comments: (p.comments ?? []).filter((c) => c.id !== id) }))}
              onSeek={(t) => playerRef.current?.seek(t)}
            />
          ) : (
            <div className="flex h-full min-h-0 flex-col">
              <div className="shrink-0 border-b border-line p-4">
                <p className="text-[13px] leading-relaxed text-ink-3">
                  A version is a snapshot of the sequence — timing, instructions and statuses. Rendered video versions arrive with the render engine.
                </p>
                <Button variant="primary" size="sm" icon={<IconSave size={15} />} className="mt-3" onClick={() => setVersionModal(true)}>
                  Save current version
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {versions.length === 0 ? (
                  <EmptyState compact className="border-none" icon={<IconHistory size={20} />} title="No versions yet" description="Save a version before sending a cut for client review." />
                ) : (
                  <ol className="flex flex-col gap-2">
                    {versions.map((v, i) => {
                      const ok = v.segments.filter((s) => s.status === 'approved').length;
                      return (
                        <li key={v.id} className="rounded-[12px] border border-line bg-surface-2 p-3.5">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="flex items-center gap-2 truncate text-sm font-medium text-ink">
                                {v.label}
                                {i === 0 && <Badge tone="signal">Latest</Badge>}
                              </p>
                              <p className="mt-0.5 text-[12.5px] text-ink-3">
                                {formatDateTime(v.createdAt)} · <span className="timecode">{v.segments.length}</span> seg · <span className="timecode">{ok}</span> approved
                              </p>
                            </div>
                            <IconButton
                              label="Delete version"
                              size="sm"
                              variant="danger"
                              onClick={() => update((p) => ({ ...p, versions: (p.versions ?? []).filter((x) => x.id !== v.id) }))}
                            >
                              <IconTrash size={15} />
                            </IconButton>
                          </div>
                          {v.note && <p className="mt-2 text-[13px] leading-relaxed whitespace-pre-line text-ink-2">{v.note}</p>}
                          <Button size="sm" variant="ghost" className="mt-2 -ml-2 h-8" onClick={() => setRestoring(v)}>
                            Restore this version
                          </Button>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>
              <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line px-4 py-3">
                <span className="text-[12.5px] text-ink-3">Rendered previews</span>
                <UnavailableBadge />
              </div>
            </div>
          )}
        </div>
      </aside>

      <Modal
        open={versionModal}
        onClose={() => setVersionModal(false)}
        title="Save version"
        description="Snapshot the current sequence so you can compare or roll back later."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setVersionModal(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={saveVersion}>
              Save version
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-5">
          <Field label="Label" htmlFor="version-label">
            <Input id="version-label" data-autofocus value={versionLabel} onChange={(e) => setVersionLabel(e.target.value)} placeholder={`Version ${(project.versions?.length ?? 0) + 1}`} />
          </Field>
          <Field label="Note" optional htmlFor="version-note">
            <Textarea id="version-note" rows={3} value={versionNote} onChange={(e) => setVersionNote(e.target.value)} placeholder="e.g. Sent to client for first review" />
          </Field>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(restoring)}
        title="Restore this version?"
        description={`The sequence will be replaced with “${restoring?.label}”. Your current sequence is saved as a new version first, so nothing is lost.`}
        confirmLabel="Restore version"
        onCancel={() => setRestoring(null)}
        onConfirm={() => restoring && restoreVersion(restoring)}
      />
    </div>
  );
}
