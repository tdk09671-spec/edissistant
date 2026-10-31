import { useEffect, useRef } from 'react';
import type { Segment } from '../types';
import { segmentStatusInfo, visualModeInfo } from '../lib/catalog';
import { formatTimecode } from '../lib/time';
import { Badge, cn } from './ui';

interface SequenceTableProps {
  segments: Segment[];
  /** Index numbers as shown to the user (stable across filtering) */
  numbering: Map<string, number>;
  fps: number;
  selectedId: string | null;
  activeId?: string | null;
  onSelect: (segment: Segment) => void;
  onSeek: (time: number) => void;
  onEdit: (segment: Segment) => void;
}

export function SequenceTable({ segments, numbering, fps, selectedId, activeId, onSelect, onSeek, onEdit }: SequenceTableProps) {
  const selectedRow = useRef<HTMLTableRowElement>(null);

  useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  return (
    <table className="w-full min-w-[940px] table-fixed border-separate border-spacing-0 text-left">
      <colgroup>
        <col className="w-[52px]" />
        <col className="w-[124px]" />
        <col />
        <col className="w-[148px]" />
        <col />
        <col className="w-[18%]" />
        <col className="w-[156px]" />
      </colgroup>
      <thead className="sticky top-0 z-10 bg-surface-1">
        <tr className="text-[12px] font-medium tracking-[0.04em] text-ink-3 uppercase">
          {['#', 'Timecode', 'Transcript', 'Visual', 'Editor instruction', 'AI suggestion', 'Status'].map((h, i) => (
            <th key={h} scope="col" className={cn('h-10 truncate border-b border-line px-3 font-medium whitespace-nowrap', i === 0 && 'pl-5')}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {segments.map((segment) => {
          const selected = segment.id === selectedId;
          const active = segment.id === activeId;
          // Until the editor approves it, a planned row shows the suggested mode (marked as such).
          const suggested = Boolean(segment.plan) && segment.status !== 'approved';
          const mode = visualModeInfo(segment.plan && suggested ? segment.plan.mode : segment.visualMode);
          const plan = segment.plan;
          const status = segmentStatusInfo(segment.status);
          return (
            <tr
              key={segment.id}
              ref={selected ? selectedRow : undefined}
              aria-selected={selected}
              tabIndex={0}
              onClick={() => onSelect(segment)}
              onDoubleClick={() => onEdit(segment)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onEdit(segment);
                }
              }}
              className={cn(
                'group cursor-pointer align-top text-[13.5px] transition-colors focus-visible:outline-offset-[-2px]',
                selected ? 'bg-surface-3' : 'hover:bg-surface-2'
              )}
            >
              <td className="relative border-b border-line py-3.5 pr-3 pl-5">
                {selected && <span className="absolute inset-y-0 left-0 w-[3px] bg-signal" />}
                <span className={cn('timecode text-[12.5px]', active ? 'text-signal' : 'text-ink-3')}>
                  {String(numbering.get(segment.id) ?? 0).padStart(2, '0')}
                </span>
              </td>
              <td className="border-b border-line px-3 py-2.5">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(segment);
                    onSeek(segment.start);
                  }}
                  className="timecode -mx-1.5 flex flex-col rounded-[6px] px-1.5 py-1 text-left text-[12.5px] leading-snug hover:bg-surface-4"
                  title="Jump to segment"
                >
                  <span className="text-ink">
                    {segment.startUncertain && (
                      <span data-testid="start-uncertain" className="mr-0.5 text-warning" title="Start not verified against the audio (music, overlapping voices or no clear onset): a graphic here may start early or late.">
                        ≈
                      </span>
                    )}
                    {formatTimecode(segment.start, fps)}
                  </span>
                  <span className="text-ink-3">
                    {segment.endUncertain && (
                      <span data-testid="end-uncertain" className="mr-0.5 text-warning" title="End not verified against the audio: the speech may stop earlier, and a graphic here may run into the pause.">
                        ≈
                      </span>
                    )}
                    {formatTimecode(segment.end, fps)}
                  </span>
                  {segment.visualTiming && (
                    <span data-testid="visual-adjusted" className="mt-0.5 text-[11px] text-warning" title={`Graphic shown ${formatTimecode(segment.visualTiming.start, fps)} → ${formatTimecode(segment.visualTiming.end, fps)} (adjusted by the editor)`}>
                      Graphic adjusted
                    </span>
                  )}
                </button>
              </td>
              <td className="border-b border-line px-3 py-3.5">
                <p className={cn('line-clamp-2 leading-relaxed', segment.transcript ? 'text-ink-2' : 'text-ink-4')}>
                  {segment.transcript || 'No transcript'}
                </p>
              </td>
              <td className="border-b border-line px-3 py-3.5">
                <span className={cn('inline-flex items-center gap-2 text-[13px] whitespace-nowrap', suggested ? 'text-ink-3' : 'text-ink-2')}>
                  <span className="size-2 shrink-0 rounded-full" style={{ background: mode.color, opacity: suggested ? 0.55 : 1 }} />
                  {mode.label}
                </span>
                {suggested && <span className="mt-0.5 block text-[11.5px] text-ink-4">suggested</span>}
              </td>
              <td className="border-b border-line px-3 py-3.5">
                <p className={cn('line-clamp-2 leading-relaxed', segment.instruction ? 'text-ink' : 'text-ink-4')}>
                  {segment.instruction || 'Add an instruction…'}
                </p>
              </td>
              <td className="border-b border-line px-3 py-3.5">
                {plan ? (
                  <div className="flex flex-col gap-0.5" data-testid="row-suggestion">
                    <p className="flex items-center gap-1.5 truncate font-medium text-ink">
                      <span className="truncate">{plan.conceptLabel}</span>
                      {plan.source === 'model' && !plan.editorChoice && (
                        <span data-testid="row-source-claude" className="shrink-0 rounded-full bg-signal-soft px-1.5 text-[10.5px] font-medium text-signal">
                          Claude
                        </span>
                      )}
                    </p>
                    <p className="line-clamp-2 text-[12.5px] leading-relaxed text-ink-3">
                      {plan.stale ? 'Changed after approval: review it' : !plan.renderable ? plan.unsupportedReason : plan.reasoning}
                    </p>
                  </div>
                ) : (
                  <p className={cn('line-clamp-2 leading-relaxed', segment.aiSuggestion ? 'text-ink-2' : 'text-ink-4 italic')}>
                    {segment.aiSuggestion || 'Not planned yet'}
                  </p>
                )}
              </td>
              <td className="border-b border-line px-3 py-3">
                <Badge tone={status.tone} dot>
                  {status.label}
                </Badge>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
