import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import type { ReviewComment, Segment } from '../types';
import { visualModeInfo } from '../lib/catalog';
import { formatTimecode } from '../lib/time';
import { IconButton, Tooltip, cn } from './ui';
import { IconAlert, IconBack5, IconExpand, IconForward5, IconMute, IconPause, IconPlay, IconStepBack, IconStepForward, IconVolume } from './ui/icons';

export interface PlayerHandle {
  seek: (time: number) => void;
  togglePlay: () => void;
  pause: () => void;
  step: (frames: number) => void;
  nudge: (seconds: number) => void;
  getTime: () => number;
}

interface VideoPlayerShellProps {
  src: string | null;
  fps: number;
  segments?: Segment[];
  comments?: ReviewComment[];
  selectedSegmentId?: string | null;
  onTimeChange?: (time: number) => void;
  onDuration?: (duration: number) => void;
  empty?: ReactNode;
  size?: 'compact' | 'large';
  className?: string;
}

const RATES = [0.5, 1, 1.5, 2];

export const VideoPlayerShell = forwardRef<PlayerHandle, VideoPlayerShellProps>(function VideoPlayerShell(
  { src, fps, segments = [], comments = [], selectedSegmentId, onTimeChange, onDuration, empty, size = 'compact', className },
  ref
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const scrubbing = useRef(false);
  const rafRef = useRef<number | undefined>(undefined);

  const report = useCallback(
    (t: number) => {
      setTime(t);
      onTimeChange?.(t);
    },
    [onTimeChange]
  );

  const seek = useCallback(
    (t: number) => {
      const v = videoRef.current;
      if (!v || !Number.isFinite(v.duration)) return;
      v.currentTime = Math.max(0, Math.min(t, v.duration));
      report(v.currentTime);
    },
    [report]
  );

  useImperativeHandle(
    ref,
    () => ({
      seek,
      togglePlay: () => {
        const v = videoRef.current;
        if (!v || error || !loaded) return;
        if (v.paused) v.play().catch(() => undefined);
        else v.pause();
      },
      pause: () => videoRef.current?.pause(),
      step: (frames: number) => {
        const v = videoRef.current;
        if (!v) return;
        v.pause();
        seek(v.currentTime + frames / fps);
      },
      nudge: (seconds: number) => {
        const v = videoRef.current;
        if (v) seek(v.currentTime + seconds);
      },
      getTime: () => videoRef.current?.currentTime ?? 0,
    }),
    [seek, fps, error, loaded]
  );

  // Smooth playhead while playing
  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      const v = videoRef.current;
      if (v) report(v.currentTime);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current!);
  }, [playing, report]);

  useEffect(() => {
    setError(null);
    setLoaded(false);
    setPlaying(false);
    setDuration(0);
    setTime(0);
  }, [src]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, [rate]);

  const timeFromPointer = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || !duration) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!loaded) return;
    scrubbing.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    seek(timeFromPointer(e.clientX));
  };

  const pct = (t: number) => (duration ? `${(t / duration) * 100}%` : '0%');

  if (!src) {
    return (
      <div className={cn('flex h-full min-h-0 items-center justify-center rounded-[14px] border border-line bg-surface-1', className)}>
        {empty}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={cn('flex h-full min-h-0 flex-col overflow-hidden rounded-[14px] border border-line bg-black', className)}
    >
      <div className="relative min-h-0 flex-1">
        <video
          ref={videoRef}
          src={src}
          className="absolute inset-0 h-full w-full object-contain"
          preload="metadata"
          muted={muted}
          onClick={() => {
            const v = videoRef.current;
            if (v && loaded) v.paused ? v.play().catch(() => undefined) : v.pause();
          }}
          onLoadedMetadata={(e) => {
            setDuration(e.currentTarget.duration);
            setLoaded(true);
            onDuration?.(e.currentTarget.duration);
          }}
          onTimeUpdate={(e) => !playing && report(e.currentTarget.currentTime)}
          onSeeked={(e) => report(e.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onError={() =>
            setError(
              'This file can’t be previewed. Chromium plays H.264, HEVC (with OS support), VP9 and AV1 in MP4, MOV or WebM. ProRes and DNxHR need a proxy.'
            )
          }
        />
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface-1 px-8 text-center">
            <IconAlert size={22} className="text-warning" />
            <p className="text-sm font-medium text-ink">Preview unavailable</p>
            <p className="max-w-md text-[13px] leading-relaxed text-ink-3">{error}</p>
          </div>
        )}
        {!error && !loaded && (
          <div className="absolute inset-0 flex items-center justify-center text-[13px] text-ink-3">Loading media…</div>
        )}
      </div>

      {/* Transport */}
      <div className="@container shrink-0 border-t border-line bg-surface-1 px-3 pt-2.5 pb-2">
        {/* Scrub bar with segment and comment markers */}
        <div
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label="Playhead"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(time)}
          aria-valuetext={formatTimecode(time, fps)}
          onPointerDown={onPointerDown}
          onPointerMove={(e) => scrubbing.current && seek(timeFromPointer(e.clientX))}
          onPointerUp={() => (scrubbing.current = false)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              e.preventDefault();
              e.stopPropagation();
              seek(time + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 1 : 1 / fps));
            }
          }}
          className={cn('group relative h-7 cursor-pointer touch-none rounded-[6px] focus-visible:outline-offset-1', !loaded && 'cursor-default opacity-50')}
        >
          <div className="absolute inset-x-0 top-1/2 h-[18px] -translate-y-1/2 overflow-hidden rounded-[5px] bg-surface-3">
            {segments.map((s) => (
              <div
                key={s.id}
                className={cn('absolute inset-y-0 border-r border-surface-1', s.id === selectedSegmentId ? 'opacity-90' : 'opacity-35')}
                style={{ left: pct(s.start), width: duration ? `${((s.end - s.start) / duration) * 100}%` : 0, background: visualModeInfo(s.visualMode).color }}
              />
            ))}
            <div className="absolute inset-y-0 left-0 bg-white/8" style={{ width: pct(time) }} />
          </div>
          {comments.map((c) => (
            <span
              key={c.id}
              className={cn('absolute -top-0.5 size-[7px] -translate-x-1/2 rounded-full', c.resolved ? 'bg-ink-4' : 'bg-signal')}
              style={{ left: pct(c.time) }}
            />
          ))}
          <div className="pointer-events-none absolute inset-y-0 w-[2px] -translate-x-1/2 rounded-full bg-ink" style={{ left: pct(time) }}>
            <span className="absolute -top-0.5 left-1/2 size-2.5 -translate-x-1/2 rounded-full bg-ink" />
          </div>
        </div>

        <div className="mt-1.5 flex items-center gap-1">
          <IconButton label={playing ? 'Pause (Space)' : 'Play (Space)'} size={size === 'large' ? 'md' : 'sm'} disabled={!loaded} onClick={() => {
            const v = videoRef.current;
            if (v) v.paused ? v.play().catch(() => undefined) : v.pause();
          }} className="text-ink">
            {playing ? <IconPause size={17} /> : <IconPlay size={17} />}
          </IconButton>
          <IconButton label="Back 5 seconds (J)" size="sm" disabled={!loaded} onClick={() => seek(time - 5)} className="hidden @lg:inline-flex">
            <IconBack5 size={16} />
          </IconButton>
          <IconButton label="Forward 5 seconds (L)" size="sm" disabled={!loaded} onClick={() => seek(time + 5)} className="hidden @lg:inline-flex">
            <IconForward5 size={16} />
          </IconButton>
          <IconButton label="Previous frame (←)" size="sm" disabled={!loaded} onClick={() => { videoRef.current?.pause(); seek(time - 1 / fps); }} className="hidden @md:inline-flex">
            <IconStepBack size={15} />
          </IconButton>
          <IconButton label="Next frame (→)" size="sm" disabled={!loaded} onClick={() => { videoRef.current?.pause(); seek(time + 1 / fps); }} className="hidden @md:inline-flex">
            <IconStepForward size={15} />
          </IconButton>
          <div className="timecode ml-2 shrink-0 text-[13px] whitespace-nowrap text-ink">
            {formatTimecode(time, fps)}
            <span className="hidden text-ink-4 @sm:inline"> / {formatTimecode(duration, fps)}</span>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Tooltip content="Playback speed">
              <button
                type="button"
                disabled={!loaded}
                onClick={() => setRate(RATES[(RATES.indexOf(rate) + 1) % RATES.length])}
                className="timecode h-8 min-w-11 rounded-[8px] px-2 text-[12.5px] text-ink-2 hover:bg-surface-3 hover:text-ink disabled:text-ink-4"
              >
                {rate}×
              </button>
            </Tooltip>
            <IconButton label={muted ? 'Unmute' : 'Mute'} size="sm" onClick={() => setMuted((m) => !m)}>
              {muted ? <IconMute size={16} /> : <IconVolume size={16} />}
            </IconButton>
            <IconButton label="Full screen" size="sm" disabled={!loaded} onClick={() => containerRef.current?.requestFullscreen?.().catch(() => undefined)}>
              <IconExpand size={15} />
            </IconButton>
          </div>
        </div>
      </div>
    </div>
  );
});
