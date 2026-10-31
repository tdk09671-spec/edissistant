import { describe, expect, it } from 'vitest';
import { fileTimecode } from '../../../src/renderer/lib/pipeline';

// Frame-exact timing is tested where the code lives:
//  - preview placement at 24000/1001 and 30000/1001 with real FFmpeg: tests/unit/render/compose.test.ts (PR #2)
//  - NTSC timecode display and parsing: tests/unit/time.test.ts (#5)
//  - graphics on their exact frames in a real composite: tests/e2e/pipeline.spec.ts
// This file covers what the integration adds: exported clips named by their timeline position.

describe('export file names', () => {
  it('name clips by the frame they land on in the composite (rounded to the frame grid)', () => {
    // 16.166 s at 30000/1001 is frame 484 = 00:00:16:04 non-drop; 1.064 s at 24000/1001 is frame 26 = 00:00:01:02.
    expect(fileTimecode(16.166, 29.97)).toBe('00-00-16-04');
    expect(fileTimecode(1.064, 23.976)).toBe('00-00-01-02');
    expect(fileTimecode(83.48, 25)).toBe('00-01-23-12');
  });
});
