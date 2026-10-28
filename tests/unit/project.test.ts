import { describe, expect, it } from 'vitest';
import { defaultExportSettings, createSegment, fileName, getSegments, mediaUrl, segmentAt } from '../../src/renderer/lib/project';
import { defaultSettings } from '../../src/renderer/state/DataProvider';
import type { Project } from '../../src/renderer/types';

const baseProject: Project = {
  id: 'p1',
  name: 'Spring: "launch" / v2',
  presetId: 'x',
  presetName: 'X',
  status: 'draft',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('segments', () => {
  it('clamps negative starts and inverted ranges', () => {
    expect(createSegment(-2, 3).start).toBe(0);
    expect(createSegment(4, 2).end).toBe(4);
  });
  it('sorts segments and finds the one under the playhead', () => {
    const a = createSegment(5, 10);
    const b = createSegment(0, 5);
    const sorted = getSegments({ ...baseProject, segments: [a, b] });
    expect(sorted.map((s) => s.start)).toEqual([0, 5]);
    expect(segmentAt(sorted, 5)?.id).toBe(a.id);
    expect(segmentAt(sorted, 10)).toBeUndefined();
  });
});

describe('media paths', () => {
  it('builds media protocol URLs from Windows paths', () => {
    expect(mediaUrl('C:\\Media\\clip one.mp4')).toBe('edissistant-media://local/C%3A%2FMedia%2Fclip%20one.mp4');
  });
  it('extracts file names from either separator', () => {
    expect(fileName('C:\\a\\b.mp4')).toBe('b.mp4');
    expect(fileName('/a/b.srt')).toBe('b.srt');
  });
});

describe('defaultExportSettings', () => {
  it('derives a safe file name and falls back to app defaults', () => {
    const s = defaultExportSettings(baseProject, defaultSettings);
    expect(s.fileName).toBe('Spring launch  v2');
    expect(s.resolution).toBe(defaultSettings.defaultResolution);
  });
  it('keeps settings saved on the project', () => {
    const s = defaultExportSettings({ ...baseProject, exportSettings: { format: 'transparent-motion', resolution: '3840x2160', frameRate: '60', destination: '', fileName: 'x' } }, defaultSettings);
    expect(s.frameRate).toBe('60');
    expect(s.fileName).toBe('x');
  });
});
