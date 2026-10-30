import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useData } from '../../state/DataProvider';
import { builtInPresets, presetTypeInfo, segmentStatuses, visualModes } from '../../lib/catalog';
import { formatClock, formatPrecise, formatTimecode, parseTime } from '../../lib/time';
import { fileName, isElectron } from '../../lib/project';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  IconButton,
  Input,
  Notice,
  SegmentedControl,
  Select,
  Textarea,
  Tooltip,
  cn,
} from '../../components/ui';
import { CONCEPTS } from '../../../shared/planning/concepts';
import type { Pipeline } from './usePipeline';
import {
  IconArrowRight,
  IconChevronLeft,
  IconChevronRight,
  IconCrosshair,
  IconFilm,
  IconInfo,
  IconScissors,
  IconSparkle,
  IconText,
  IconTrash,
  IconUpload,
} from '../../components/ui/icons';
import type { Project, Segment, SegmentBuildResult, VisualMode } from '../../types';

/* ---------- Time input ---------- */

function TimeField({ label, value, fps, onCommit, onFromPlayhead }: { label: string; value: number; fps: number; onCommit: (t: number) => void; onFromPlayhead?: () => void }) {
  const [text, setText] = useState(formatPrecise(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(formatPrecise(value));
    setInvalid(false);
  }, [value]);

  const commit = () => {
    const parsed = parseTime(text, fps);
    if (parsed === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onCommit(parsed);
  };

  return (
    <Field label={label} error={invalid ? 'Try 1:23.5 or 00:01:23:12' : undefined}>
      <Input
        aria-label={label}
        value={text}
        invalid={invalid}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        className="timecode min-w-0"
        trailing={
          onFromPlayhead && (
            <Tooltip content={`Set ${label === 'In' ? 'in' : 'out'} point to playhead (${label === 'In' ? 'I' : 'O'})`}>
              <IconButton label={`Set ${label} to playhead`} size="sm" onClick={onFromPlayhead}>
                <IconCrosshair size={16} />
              </IconButton>
            </Tooltip>
          )
        }
      />
    </Field>
  );
}

/* ---------- Segment inspector ---------- */

interface SegmentInspectorProps {
  segment: Segment | null;
  index: number;
  total: number;
  fps: number;
  canUsePlayhead: boolean;
  playhead: number;
  instructionRef: React.RefObject<HTMLTextAreaElement | null>;
  onChange: (patch: Partial<Segment>) => void;
  onDelete: () => void;
  onSplit: () => void;
  canSplit: boolean;
  onPrev: () => void;
  onNext: () => void;
  pipeline: Pipeline;
  /** This row's result in the last rendered preview. */
  buildResult?: SegmentBuildResult;
}

const PLAN_STATUS: Record<string, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }> = {
  suggested: { label: 'Suggested', tone: 'info' },
  edited: { label: 'Edited', tone: 'info' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  'needs-regeneration': { label: 'Needs a new idea', tone: 'warning' },
};

const BUILD_LABEL: Record<SegmentBuildResult['status'], string> = {
  renderable: 'Rendered in the last preview',
  'no-graphic': 'No graphic (stays on the footage)',
  unsupported: 'Not renderable',
  'missing-data': 'Missing data',
  'missing-assets': 'Missing assets',
  'not-approved': 'Not rendered',
};

/** The creative plan for one row, with the editor's decisions. */
function SuggestionPanel({ segment, pipeline, buildResult }: { segment: Segment; pipeline: Pipeline; buildResult?: SegmentBuildResult }) {
  const plan = segment.plan;
  const busy = Boolean(pipeline.job);
  if (!plan) {
    return (
      <div className="rounded-[12px] border border-dashed border-line-strong p-4">
        <div className="flex gap-3">
          <IconSparkle size={17} className="mt-0.5 shrink-0 text-ink-3" />
          <p className="text-[13px] leading-relaxed text-ink-3">
            {segment.transcript.trim()
              ? 'No suggestion yet. Run Suggest visuals to plan this segment from the client preset. Planning runs locally; no AI service is called.'
              : 'Add the transcript for this segment to get a suggestion.'}
          </p>
        </div>
      </div>
    );
  }
  const status = PLAN_STATUS[plan.planStatus] ?? PLAN_STATUS.suggested;
  const approved = plan.planStatus === 'approved' && !plan.stale;
  return (
    <div data-testid="suggestion-panel" className="flex flex-col gap-3 rounded-[12px] border border-line bg-surface-1 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium text-ink" data-testid="suggestion-concept">
          {plan.conceptLabel}
        </p>
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className="ml-auto text-[12px] text-ink-3">{plan.editorChoice ? 'Your choice' : plan.source === 'model' ? 'Claude' : 'Local planner'}</span>
      </div>
      <p className="flex items-center gap-2 text-[12.5px] text-ink-3">
        <span className="size-2 rounded-full" style={{ background: visualModes.find((m) => m.value === plan.mode)?.color }} />
        {visualModes.find((m) => m.value === plan.mode)?.label} · {plan.meaning}
      </p>
      <p className="text-[13.5px] leading-relaxed text-ink-2">{plan.reasoning}</p>
      {plan.stale && (
        <Notice tone="signal" icon={<IconInfo size={16} />} title="Changed after approval">
          {plan.stale} It won't render until you review it.
        </Notice>
      )}
      {!plan.renderable && (
        <Notice tone="neutral" icon={<IconInfo size={16} />} title="Not a rendered graphic">
          {plan.unsupportedReason}
        </Notice>
      )}
      {buildResult && buildResult.status !== 'renderable' && buildResult.status !== 'no-graphic' && buildResult.reason && (
        <p className="text-[12.5px] leading-relaxed text-warning">
          {BUILD_LABEL[buildResult.status]}: {buildResult.reason}
        </p>
      )}
      {buildResult?.status === 'renderable' && <p className="text-[12.5px] text-success">{BUILD_LABEL.renderable}</p>}
      {plan.warnings.length > 0 && (
        <ul className="flex list-disc flex-col gap-1 pl-4 text-[12.5px] leading-relaxed text-ink-3">
          {plan.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <Field label="Concept" htmlFor="seg-concept">
        <Select
          id="seg-concept"
          value={plan.conceptId}
          disabled={busy}
          onChange={(e) => void pipeline.act(segment.id, { type: 'edit', overrides: { conceptId: e.target.value } })}
        >
          {CONCEPTS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
              {c.components === null ? ' (not renderable)' : ''}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex flex-wrap gap-2">
        {plan.stale ? (
          <>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void pipeline.act(segment.id, { type: 'acknowledge-change' })}>
              Keep approval
            </Button>
            <Tooltip content="Replace the approved idea with a new suggestion for the changed segment">
              <span>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void pipeline.suggest({ allowReplan: [segment.id] })}>
                  Re-plan with the change
                </Button>
              </span>
            </Tooltip>
          </>
        ) : (
          <Button size="sm" variant="primary" disabled={busy || approved || plan.planStatus === 'rejected'} onClick={() => void pipeline.act(segment.id, { type: 'approve' })}>
            {approved ? 'Approved' : 'Approve'}
          </Button>
        )}
        <Button size="sm" variant="secondary" disabled={busy || plan.planStatus === 'rejected'} onClick={() => void pipeline.act(segment.id, { type: 'reject', reason: 'Rejected by the editor' })}>
          Reject
        </Button>
        <Tooltip content="Ask the planner for a different idea for this segment">
          <span>
            <Button
              size="sm"
              variant="ghost"
              icon={<IconSparkle size={14} />}
              disabled={busy}
              onClick={async () => {
                if (plan.planStatus !== 'rejected' && plan.planStatus !== 'needs-regeneration') {
                  await pipeline.act(segment.id, { type: 'request-regeneration', reason: 'Editor asked for a new idea' });
                }
                await pipeline.suggest();
              }}
            >
              New idea
            </Button>
          </span>
        </Tooltip>
      </div>
    </div>
  );
}

export function SegmentInspector({
  segment,
  index,
  total,
  fps,
  canUsePlayhead,
  playhead,
  instructionRef,
  onChange,
  onDelete,
  onSplit,
  canSplit,
  onPrev,
  onNext,
  pipeline,
  buildResult,
}: SegmentInspectorProps) {
  if (!segment) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          compact
          className="w-full border-none"
          icon={<IconText size={20} />}
          title="No segment selected"
          description="Select a row in the sequence to edit its timing, visual mode and instructions."
        />
      </div>
    );
  }

  const duration = Math.max(0, segment.end - segment.start);

  return (
    <div className="flex flex-col gap-6 p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">Segment</p>
          <p className="timecode mt-1 text-[19px] font-medium text-ink">
            {String(index + 1).padStart(2, '0')}
            <span className="text-ink-4"> / {String(total).padStart(2, '0')}</span>
          </p>
        </div>
        <div className="flex items-center gap-1">
          <IconButton label="Previous segment (↑)" size="sm" disabled={index === 0} onClick={onPrev}>
            <IconChevronLeft size={17} />
          </IconButton>
          <IconButton label="Next segment (↓)" size="sm" disabled={index >= total - 1} onClick={onNext}>
            <IconChevronRight size={17} />
          </IconButton>
          <IconButton label="Split at playhead (S)" size="sm" disabled={!canSplit} onClick={onSplit}>
            <IconScissors size={16} />
          </IconButton>
          <IconButton label="Delete segment (Del)" size="sm" variant="danger" onClick={onDelete}>
            <IconTrash size={16} />
          </IconButton>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <TimeField
          label="In"
          value={segment.start}
          fps={fps}
          onCommit={(t) => onChange({ start: Math.max(0, Math.min(t, segment.end)) })}
          onFromPlayhead={canUsePlayhead ? () => onChange({ start: Math.min(playhead, segment.end) }) : undefined}
        />
        <TimeField
          label="Out"
          value={segment.end}
          fps={fps}
          onCommit={(t) => onChange({ end: Math.max(t, segment.start) })}
          onFromPlayhead={canUsePlayhead ? () => onChange({ end: Math.max(playhead, segment.start) }) : undefined}
        />
      </div>
      <p className="timecode -mt-3 text-[12.5px] text-ink-3">Duration {formatTimecode(duration, fps)}</p>

      <Field label="Visual mode">
        <div role="radiogroup" aria-label="Visual mode" className="grid grid-cols-2 gap-2">
          {visualModes.map((mode) => {
            // A planned row shows the mode its plan renders with; changing it is an editor override.
            const selected = (segment.plan?.mode ?? segment.visualMode) === mode.value;
            return (
              <button
                key={mode.value}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={Boolean(segment.plan) && Boolean(pipeline.job)}
                onClick={() =>
                  segment.plan
                    ? !selected && void pipeline.act(segment.id, { type: 'edit', overrides: { visualMode: mode.value as VisualMode } })
                    : onChange({ visualMode: mode.value })
                }
                className={cn(
                  'flex h-11 items-center gap-2.5 rounded-[10px] border px-3 text-[13.5px] font-medium transition-colors',
                  selected ? 'border-line-strong bg-surface-4 text-ink' : 'border-line text-ink-3 hover:border-line-strong hover:text-ink'
                )}
              >
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: mode.color, opacity: selected ? 1 : 0.6 }} />
                {mode.label}
              </button>
            );
          })}
        </div>
      </Field>

      <Field label="Editor instruction" htmlFor="seg-instruction" hint="What should happen here — cut, graphic, B-roll, caption style, timing.">
        <Textarea
          id="seg-instruction"
          ref={instructionRef}
          rows={4}
          value={segment.instruction}
          onChange={(e) => onChange({ instruction: e.target.value })}
          placeholder="e.g. Punch in 120% on “launch”, kinetic caption in brand amber, cut to product macro on the beat."
        />
      </Field>

      <Field label="Transcript" htmlFor="seg-transcript">
        <Textarea id="seg-transcript" rows={3} value={segment.transcript} onChange={(e) => onChange({ transcript: e.target.value })} placeholder="What is said in this segment" />
      </Field>

      <Field label="Visual suggestion">
        <SuggestionPanel segment={segment} pipeline={pipeline} buildResult={buildResult} />
      </Field>

      <Field label="Status">
        <SegmentedControl
          label="Segment status"
          fullWidth
          value={segment.status}
          onChange={(status) => (segment.plan ? void pipeline.setStatus(segment, status) : onChange({ status }))}
          options={segmentStatuses.map((s) => ({ value: s.value, label: s.label }))}
        />
      </Field>
    </div>
  );
}

/* ---------- Creative direction ---------- */

export function DirectionPanel({
  project,
  onNotes,
  onVariety,
}: {
  project: Project;
  onNotes: (notes: string) => void;
  onVariety: (variety: 'low' | 'balanced' | 'experimental') => void;
}) {
  const navigate = useNavigate();
  const { presets } = useData();
  const preset = presets.find((p) => p.id === project.presetId) ?? builtInPresets.find((p) => p.id === project.presetId);
  const segments = project.segments ?? [];
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);

  return (
    <div className="flex flex-col gap-7 p-5">
      <section>
        <div className="flex items-center justify-between gap-3">
          <p className="eyebrow">Preset</p>
          {preset && !preset.builtIn && (
            <Button size="sm" variant="ghost" iconRight={<IconArrowRight size={14} />} onClick={() => navigate(`/presets/${preset.id}`)}>
              Open
            </Button>
          )}
        </div>
        {preset ? (
          <div className="mt-3 flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-[11px] border border-line-strong text-ink-2">{presetTypeInfo(preset.type).icon(18)}</span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink">{preset.name}</p>
                <p className="truncate text-[12.5px] text-ink-3">{preset.builtIn ? 'Built-in template' : preset.clientName || 'No client'}</p>
              </div>
            </div>
            {preset.creativeBrief && <p className="text-[13.5px] leading-relaxed whitespace-pre-line text-ink-2">{preset.creativeBrief}</p>}
            <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-[13px]">
              <dt className="text-ink-3">Fonts</dt>
              <dd className="truncate text-ink-2">{preset.fonts || '—'}</dd>
              <dt className="text-ink-3">Letter spacing</dt>
              <dd className="truncate text-ink-2">{preset.tracking || '—'}</dd>
              <dt className="text-ink-3">Colours</dt>
              <dd className="flex flex-wrap gap-1.5">
                {preset.brandColors?.length
                  ? preset.brandColors.map((c, i) => <span key={i} title={c} className="size-5 rounded-full border border-line-strong" style={{ background: c }} />)
                  : <span className="text-ink-2">—</span>}
              </dd>
              <dt className="text-ink-3">References</dt>
              <dd className="text-ink-2">{preset.referenceLinks.length + preset.referenceFiles.length || '—'}</dd>
            </dl>
            {preset.brandingNotes && (
              <Notice tone="neutral" icon={<IconInfo size={16} />}>
                <span className="whitespace-pre-line">{preset.brandingNotes}</span>
              </Notice>
            )}
          </div>
        ) : (
          <p className="mt-3 text-[13px] text-ink-3">The preset “{project.presetName}” is no longer in your library. The project still works.</p>
        )}
      </section>

      <Field label="Project direction notes" htmlFor="project-notes" hint="Overrides or additions to the preset for this project only.">
        <Textarea id="project-notes" rows={5} value={project.creativeNotes ?? ''} onChange={(e) => onNotes(e.target.value)} placeholder="e.g. Client wants a slower opening and no music under the first line." />
      </Field>

      <Field
        label="Creative variety"
        hint="How strongly the planner avoids repeating concepts. The same transcript and preset always give the same plan; approved choices are never changed."
      >
        <SegmentedControl<'low' | 'balanced' | 'experimental'>
          label="Creative variety"
          fullWidth
          value={project.planning?.variety ?? 'balanced'}
          onChange={onVariety}
          options={[
            { value: 'low', label: 'Low' },
            { value: 'balanced', label: 'Balanced' },
            { value: 'experimental', label: 'Experimental' },
          ]}
        />
      </Field>

      <section>
        <p className="eyebrow">Visual mix</p>
        {segments.length === 0 ? (
          <p className="mt-3 text-[13px] text-ink-3">Add segments to see how the edit is balanced.</p>
        ) : (
          <>
            <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-surface-3">
              {visualModes.map((mode) => {
                const d = segments.filter((s) => s.visualMode === mode.value).reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
                return d > 0 ? <div key={mode.value} style={{ width: `${(d / (total || 1)) * 100}%`, background: mode.color }} /> : null;
              })}
            </div>
            <ul className="mt-3 grid grid-cols-2 gap-2 text-[13px]">
              {visualModes.map((mode) => {
                const count = segments.filter((s) => s.visualMode === mode.value).length;
                return (
                  <li key={mode.value} className="flex items-center gap-2 text-ink-2">
                    <span className="size-2 rounded-full" style={{ background: mode.color }} />
                    {mode.label}
                    <span className="timecode ml-auto text-ink-3">{count}</span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

/* ---------- Source ---------- */

export function SourcePanel({
  project,
  onChooseSource,
  onRemoveSource,
  onImportCaptions,
  onTranscribe,
  busy,
}: {
  project: Project;
  onChooseSource: () => void;
  onRemoveSource: () => void;
  onImportCaptions: () => void;
  onTranscribe: () => void;
  busy: boolean;
}) {
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (project.source && window.electronAPI) window.electronAPI.fileExists(project.source.path).then((ok) => setMissing(!ok));
    else setMissing(false);
  }, [project.source]);

  return (
    <div className="flex flex-col gap-7 p-5">
      <section className="flex flex-col gap-3">
        <p className="eyebrow">Source media</p>
        {project.source ? (
          <div className="rounded-[12px] border border-line bg-surface-1 p-4">
            <div className="flex items-start gap-3">
              <IconFilm size={18} className="mt-0.5 shrink-0 text-ink-3" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{fileName(project.source.path)}</p>
                <p className="mt-0.5 truncate text-[12.5px] text-ink-3" title={project.source.path}>
                  {project.source.path}
                </p>
                {project.source.duration ? <p className="timecode mt-1.5 text-[12.5px] text-ink-2">{formatClock(project.source.duration)}</p> : null}
              </div>
            </div>
            {missing && (
              <Notice tone="danger" className="mt-3" icon={<IconInfo size={16} />}>
                The file was moved or deleted. Choose it again to relink.
              </Notice>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={onChooseSource}>
                {missing ? 'Relink…' : 'Replace…'}
              </Button>
              {!missing && (
                <Button size="sm" variant="ghost" onClick={() => window.electronAPI?.showItemInFolder(project.source!.path)}>
                  Reveal
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={onRemoveSource}>
                Remove
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            disabled={!isElectron}
            onClick={onChooseSource}
            className="flex min-h-[96px] flex-col items-center justify-center gap-2 rounded-[12px] border border-dashed border-line-strong text-[13.5px] text-ink-2 hover:border-ink-4 hover:bg-surface-1 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            <IconUpload size={20} />
            {isElectron ? 'Choose a video file…' : 'Available in the desktop app'}
          </button>
        )}
        <p className="text-[12.5px] leading-relaxed text-ink-3">Media stays where it is on disk; the project stores a link to it.</p>
      </section>

      <section className="flex flex-col gap-3">
        <p className="eyebrow">Transcript</p>
        <p className="text-[13px] leading-relaxed text-ink-2">
          Import an <span className="timecode">.srt</span> or <span className="timecode">.vtt</span> file to create one timed segment per caption. Plain{' '}
          <span className="timecode">.txt</span> creates one untimed segment per paragraph.
        </p>
        <Button variant="secondary" icon={<IconUpload size={16} />} disabled={!isElectron} onClick={onImportCaptions} className="self-start">
          Import captions…
        </Button>
        <Notice
          tone="neutral"
          icon={<IconSparkle size={16} />}
          title="Local transcription"
          action={
            <Button size="sm" variant="secondary" disabled={!isElectron || !project.source || missing || busy} onClick={onTranscribe}>
              Transcribe
            </Button>
          }
        >
          {project.transcription
            ? `Transcribed with whisper.cpp (${project.transcription.model}, ${project.transcription.language}, ${project.transcription.wordTiming} word timing).`
            : 'Speech-to-text with whisper.cpp on this computer. Nothing is uploaded. Needs whisper-cli and a ggml model (setup: docs/TRANSCRIPTION.md).'}
        </Notice>
      </section>
    </div>
  );
}
