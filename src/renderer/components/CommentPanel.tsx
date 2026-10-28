import { useState } from 'react';
import type { ReviewComment, Segment } from '../types';
import { formatRelative, formatTimecode } from '../lib/time';
import { Button, EmptyState, IconButton, SegmentedControl, Textarea, cn } from './ui';
import { IconCheck, IconMessage, IconTrash } from './ui/icons';

interface CommentPanelProps {
  comments: ReviewComment[];
  segments: Segment[];
  fps: number;
  playhead: number;
  onAdd: (text: string, markForRevision: boolean) => void;
  onToggleResolved: (id: string) => void;
  onDelete: (id: string) => void;
  onSeek: (time: number) => void;
  onComposerFocus?: () => void;
}

type Filter = 'open' | 'resolved' | 'all';

export function CommentPanel({ comments, segments, fps, playhead, onAdd, onToggleResolved, onDelete, onSeek, onComposerFocus }: CommentPanelProps) {
  const [text, setText] = useState('');
  const [markRevision, setMarkRevision] = useState(true);
  const [filter, setFilter] = useState<Filter>('open');

  const numbering = new Map(segments.map((s, i) => [s.id, i + 1]));
  const openCount = comments.filter((c) => !c.resolved).length;
  const list = [...comments]
    .filter((c) => (filter === 'all' ? true : filter === 'open' ? !c.resolved : c.resolved))
    .sort((a, b) => a.time - b.time);

  const submit = () => {
    if (!text.trim()) return;
    onAdd(text.trim(), markRevision);
    setText('');
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-line p-4">
        <div className="mb-2.5 flex items-center justify-between gap-3">
          <p className="text-[13px] font-medium text-ink-2">
            Comment at <span className="timecode text-signal">{formatTimecode(playhead, fps)}</span>
          </p>
        </div>
        <Textarea
          aria-label="New comment"
          rows={3}
          value={text}
          onFocus={onComposerFocus}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Describe the change — e.g. “Hold the logo two frames longer”"
          className="min-h-20"
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <label className="flex min-h-9 cursor-pointer items-center gap-2.5 text-[13px] text-ink-2">
            <input
              type="checkbox"
              checked={markRevision}
              onChange={(e) => setMarkRevision(e.target.checked)}
              className="size-4 cursor-pointer accent-[var(--color-signal)]"
            />
            Mark segment as needs revision
          </label>
          <Button size="sm" variant="primary" disabled={!text.trim()} onClick={submit}>
            Add comment
          </Button>
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 px-4 pt-3 pb-2">
        <SegmentedControl<Filter>
          label="Filter comments"
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'open', label: `Open ${openCount}` },
            { value: 'resolved', label: 'Resolved' },
            { value: 'all', label: 'All' },
          ]}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {list.length === 0 ? (
          <EmptyState
            compact
            className="mt-2 border-none"
            icon={<IconMessage size={20} />}
            title={filter === 'resolved' ? 'Nothing resolved yet' : 'No open comments'}
            description={filter === 'resolved' ? undefined : 'Pause on a frame and leave a note. Comments are pinned to the timecode and segment.'}
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {list.map((comment) => {
              const segNo = comment.segmentId ? numbering.get(comment.segmentId) : undefined;
              return (
                <li key={comment.id} className={cn('rounded-[12px] border border-line bg-surface-2 p-3.5', comment.resolved && 'opacity-60')}>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onSeek(comment.time)}
                      className="timecode h-8 rounded-[8px] bg-signal-soft px-2.5 text-[12.5px] text-signal hover:bg-signal/20"
                      title="Jump to timecode"
                    >
                      {formatTimecode(comment.time, fps)}
                    </button>
                    {segNo && <span className="timecode text-[12px] text-ink-3">Seg {String(segNo).padStart(2, '0')}</span>}
                    <span className="ml-auto text-[12px] text-ink-3">{formatRelative(comment.createdAt)}</span>
                  </div>
                  <p className={cn('mt-2.5 text-[13.5px] leading-relaxed break-words whitespace-pre-line', comment.resolved ? 'text-ink-3 line-through' : 'text-ink')}>
                    {comment.text}
                  </p>
                  <div className="mt-2 -mb-1 flex items-center justify-end gap-1">
                    <Button size="sm" variant="ghost" icon={<IconCheck size={15} />} onClick={() => onToggleResolved(comment.id)} className="h-8">
                      {comment.resolved ? 'Reopen' : 'Resolve'}
                    </Button>
                    <IconButton label="Delete comment" size="sm" variant="danger" onClick={() => onDelete(comment.id)}>
                      <IconTrash size={15} />
                    </IconButton>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
