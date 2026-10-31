import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ExportFormat, ExportRecord, ExportSettings, Project, RenderTarget } from '../types';
import { changesNotRendered } from '../lib/pipeline';
import { resolutions } from '../lib/catalog';
import { formatDateTime } from '../lib/time';
import type { Pipeline } from '../pages/project/usePipeline';
import { PipelineStatus } from './PipelineStatus';
import { Badge, Button, Card, Modal, Notice } from './ui';
import { IconCheckCircle, IconFolder, IconInfo, IconPlay } from './ui/icons';

export const exportFormats: Array<{ value: ExportFormat; title: string; description: string; container: string; target: RenderTarget }> = [
  {
    value: 'full-motion',
    title: 'Full motion graphics',
    description: 'Finished edit: the approved graphics composited over the source footage, with its audio.',
    container: 'H.264 + AAC · one MP4',
    target: 'composite',
  },
  {
    value: 'transparent-motion',
    title: 'Transparent motion graphics',
    description: 'Graphics only, with alpha, to drop onto your own timeline in Premiere, Resolve or FCP. One clip per graphic, named by its timecode.',
    container: 'ProRes 4444 · MOV with alpha per graphic',
    target: 'alpha',
  },
  {
    value: 'transparent-captions',
    title: 'Transparent captions',
    description: 'Caption layer only, with alpha and word highlighting, for every segment with a transcript. One clip per segment, named by its timecode.',
    container: 'ProRes 4444 · MOV with alpha per segment',
    target: 'captions',
  },
];

function size(bytes: number): string {
  return bytes > 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function LastExport({ record }: { record: ExportRecord }) {
  return (
    <div data-testid="last-export" className="flex flex-col gap-2 rounded-[12px] border border-line bg-surface-1 p-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[13px] font-medium text-ink">
          <IconCheckCircle size={15} className="text-success" /> Verified export
          {record.outdated && <Badge tone="warning">Outdated</Badge>}
        </span>
        <span className="text-[12px] text-ink-3">{formatDateTime(record.createdAt)}</span>
      </div>
      {record.outdated && (
        <p data-testid="last-export-outdated" className="text-[12.5px] leading-relaxed text-warning">
          Exported before these changes were applied: {record.outdated}
        </p>
      )}
      <ul className="flex flex-col gap-1.5">
        {record.files.slice(0, 6).map((f) => (
          <li key={f.path} className="flex items-center justify-between gap-2 text-[12.5px]">
            <button type="button" className="min-w-0 truncate text-left text-ink-2 hover:text-ink" title={f.path} onClick={() => window.electronAPI?.showItemInFolder(f.path)}>
              {f.path.split(/[\\/]/).pop()}
            </button>
            <span className="timecode shrink-0 text-ink-3">
              {f.video ? `${f.video.width}×${f.video.height} · ${f.video.frames} fr` : ''}
              {f.video?.hasAlpha ? ' · alpha' : ''}
              {f.audio ? ' · audio' : ''} · {size(f.sizeBytes)}
            </span>
          </li>
        ))}
        {record.files.length > 6 && <li className="text-[12.5px] text-ink-3">+ {record.files.length - 6} more</li>}
      </ul>
      <Button size="sm" variant="ghost" icon={<IconFolder size={14} />} className="-ml-2 h-8 self-start" onClick={() => window.electronAPI?.openFolder(record.folder)}>
        Open folder
      </Button>
    </div>
  );
}

/** Summary and the render action for the selected deliverable. */
export function ExportPanel({ settings, project, pipeline }: { settings: ExportSettings; project: Project; pipeline: Pipeline }) {
  const format = exportFormats.find((f) => f.value === settings.format)!;
  const res = resolutions.find((r) => r.value === settings.resolution);
  const segments = project.segments ?? [];
  const approvedGraphics = segments.filter((s) => s.status === 'approved' && s.plan?.renderable && s.plan.mode !== 'speaker' && s.plan.mode !== 'b-roll').length;
  const withTranscript = segments.filter((s) => s.transcript.trim()).length;
  const last = project.exports?.find((e) => e.target === format.target);
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  // Round 3 (Task D): requested changes that the export can't contain are named before anything is
  // written, not only afterwards. Captions don't depend on the visual plan, so they're exempt.
  const pending = format.target === 'captions' ? null : changesNotRendered(project);
  const start = () => void pipeline.exportOutput({ target: format.target, folder: settings.destination, fileName: settings.fileName.trim() });
  const toReview = () => navigate(`/projects/${project.id}/review`);

  const blocker = !window.electronAPI
    ? 'Rendering needs the desktop app.'
    : !project.source
      ? 'Link the source video in the Edit tab first.'
      : !settings.destination
        ? 'Choose a destination folder.'
        : !settings.fileName.trim()
          ? 'Enter a file name.'
          : format.target === 'captions'
            ? withTranscript === 0
              ? 'No segment has transcript text yet.'
              : null
            : approvedGraphics === 0
              ? 'Approve at least one graphic suggestion in the Edit tab.'
              : null;

  const rows: Array<[string, string]> = [
    ['Output', format.title],
    ['Format', format.container],
    ['Resolution', res ? `${res.label} · ${res.detail}` : settings.resolution],
    ['Frame rate', `${settings.frameRate} fps`],
    ['Contents', format.target === 'captions' ? `${withTranscript} caption segment(s)` : `${approvedGraphics} approved graphic(s)`],
    ['File name', settings.fileName || '—'],
    ['Destination', settings.destination || 'Not set'],
  ];

  return (
    <Card padding="md" className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[17px] font-semibold tracking-[-0.015em] text-ink">Render</h2>
        <Badge tone="outline">Local · FFmpeg</Badge>
      </div>
      <dl className="flex flex-col divide-y divide-line">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[104px_minmax(0,1fr)] gap-3 py-2.5 first:pt-0 last:pb-0 text-[13px]">
            <dt className="text-ink-3">{label}</dt>
            <dd className="min-w-0 break-words text-ink-2" title={value}>
              {value}
            </dd>
          </div>
        ))}
      </dl>

      {(pipeline.job || pipeline.error || pipeline.notice) && <PipelineStatus pipeline={pipeline} />}
      {!pipeline.job && blocker && (
        <Notice tone="neutral" icon={<IconInfo size={16} />}>
          {blocker}
        </Notice>
      )}
      {!pipeline.job && pending && (
        <Notice
          tone="signal"
          icon={<IconInfo size={16} />}
          title="Not every requested change is in this export"
          action={
            <Button size="sm" variant="secondary" onClick={toReview}>
              Go to Review
            </Button>
          }
        >
          <span data-testid="export-pending-changes">{pending}</span>
        </Notice>
      )}

      <Button
        variant="primary"
        size="lg"
        icon={<IconPlay size={16} />}
        disabled={Boolean(blocker) || Boolean(pipeline.job)}
        className="w-full"
        onClick={() => (pending ? setConfirming(true) : start())}
      >
        Start render
      </Button>
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Export without the pending changes?"
        description="The export would show the graphics as they were before these changes. It is marked as outdated if you go ahead."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={toReview}>
              Go to Review
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirming(false);
                start();
              }}
            >
              Export anyway
            </Button>
          </>
        }
      >
        <p className="text-[13.5px] leading-relaxed text-ink-2">{pending}</p>
      </Modal>
      {last && <LastExport record={last} />}
    </Card>
  );
}
