import type { Pipeline } from '../pages/project/usePipeline';
import { Button, IconButton, Notice, Spinner, cn } from './ui';
import { IconAlert, IconCheckCircle, IconClose, IconInfo } from './ui/icons';

/** Live state of the project's pipeline job: progress with cancel, then the outcome or the error. */
export function PipelineStatus({ pipeline, className }: { pipeline: Pipeline; className?: string }) {
  const { job, error, notice } = pipeline;
  if (job) {
    const pct = job.progress === null ? null : Math.round(job.progress * 100);
    return (
      <div role="status" aria-live="polite" data-testid="pipeline-job" className={cn('flex items-center gap-4 rounded-[14px] border border-line bg-surface-1 px-4 py-3', className)}>
        <Spinner size={16} className="shrink-0 text-signal" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm font-medium text-ink">{job.title}</p>
            {pct !== null && <span className="timecode text-[12.5px] text-ink-3">{pct}%</span>}
          </div>
          <p className="mt-0.5 truncate text-[12.5px] text-ink-3" title={job.message}>
            {job.message}
          </p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
            <div
              className={cn('h-full rounded-full bg-signal transition-[width] duration-300', pct === null && 'w-1/3 animate-pulse')}
              style={pct === null ? undefined : { width: `${Math.max(2, pct)}%` }}
            />
          </div>
        </div>
        <Button size="sm" variant="secondary" disabled={!job.cancellable} onClick={pipeline.cancel}>
          Cancel
        </Button>
      </div>
    );
  }
  if (error) {
    return (
      <Notice
        tone="danger"
        className={className}
        icon={<IconAlert size={16} />}
        title={error.title}
        action={
          <IconButton label="Dismiss" size="sm" onClick={pipeline.dismiss}>
            <IconClose size={15} />
          </IconButton>
        }
      >
        <span data-testid="pipeline-error" className="break-words">
          {error.message}
          {error.code ? <span className="timecode ml-2 text-ink-4">{error.code}</span> : null}
        </span>
      </Notice>
    );
  }
  if (notice) {
    return (
      <Notice
        tone={notice.tone === 'success' ? 'success' : notice.tone === 'warning' ? 'signal' : 'neutral'}
        className={className}
        icon={notice.tone === 'success' ? <IconCheckCircle size={16} /> : <IconInfo size={16} />}
        title={notice.title}
        action={
          <IconButton label="Dismiss" size="sm" onClick={pipeline.dismiss}>
            <IconClose size={15} />
          </IconButton>
        }
      >
        <span data-testid="pipeline-notice" data-tone={notice.tone}>
          {notice.message}
        </span>
      </Notice>
    );
  }
  return null;
}
