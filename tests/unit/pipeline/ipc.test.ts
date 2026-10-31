import { describe, expect, it } from 'vitest';
import { validators } from '../../../src/main/pipeline/ipc';

// The renderer's rows cross the IPC boundary through these validators. A field they don't copy
// is silently lost: the editor's graphic in/out was, until this check existed (round 3, Task B).
describe('pipeline IPC row validation', () => {
  const row = { id: 'r1', start: 1, end: 3, transcript: 'Hello there.', instruction: '' };

  it('keeps the editor’s graphic in/out and leaves rows without one unchanged', () => {
    const [kept] = validators.segments([{ ...row, visualTiming: { start: 1.2, end: 2.5 } }]);
    expect(kept.visualTiming).toEqual({ start: 1.2, end: 2.5 });
    const [plain] = validators.segments([row]);
    expect(plain).not.toHaveProperty('visualTiming');
  });

  it('refuses a graphic in/out that is not two ordered times', () => {
    expect(() => validators.segments([{ ...row, visualTiming: { start: 2, end: 1 } }])).toThrow(/end after it starts/);
    expect(() => validators.segments([{ ...row, visualTiming: { start: 'x', end: 1 } }])).toThrow();
    expect(() => validators.segments([{ ...row, visualTiming: 5 }])).toThrow();
  });
});
