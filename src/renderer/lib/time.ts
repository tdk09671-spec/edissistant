/** Formats seconds as HH:MM:SS:FF (SMPTE-style, non-drop) at the given frame rate. */
export function formatTimecode(seconds: number, fps = 25): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const rate = Math.round(fps) || 25;
  const totalFrames = Math.floor(seconds * rate + 1e-6);
  const frames = totalFrames % rate;
  const totalSeconds = Math.floor(totalFrames / rate);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return [h, m, s, frames].map((n) => String(n).padStart(2, '0')).join(':');
}

/** Short clock format: M:SS or H:MM:SS */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** Precise editable format: MM:SS.mmm (or H:MM:SS.mmm) */
export function formatPrecise(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const ms = Math.round((seconds % 1) * 1000);
  const whole = Math.floor(seconds) + (ms === 1000 ? 1 : 0);
  return `${formatClock(whole)}.${String(ms === 1000 ? 0 : ms).padStart(3, '0')}`;
}

/**
 * Parses user-entered times: "83", "83.5", "1:23", "1:23.500", "00:01:23:12" (timecode with frames).
 * Returns null when the input cannot be understood.
 */
export function parseTime(input: string, fps = 25): number | null {
  const value = input.trim().replace(',', '.');
  if (!value) return null;
  if (/^\d+(\.\d+)?$/.test(value)) return parseFloat(value);
  const parts = value.split(':');
  if (parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  const nums = parts.map(Number);
  if (nums.length === 4) {
    const [h, m, s, f] = nums;
    return h * 3600 + m * 60 + s + f / (Math.round(fps) || 25);
  }
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  return null;
}

export function formatRelative(iso: string): string {
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (Number.isNaN(diff)) return '';
  if (diff < minute) return 'Just now';
  if (diff < hour) return `${Math.floor(diff / minute)} min ago`;
  if (diff < day) return `${Math.floor(diff / hour)} h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} d ago`;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
