import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const fixtures = path.resolve(__dirname, '../../fixtures/transcription');
export const fakeWhisper = path.join(fixtures, 'fake-whisper-cli.cjs');

/** FFmpeg on this machine, or undefined (tests that need it are skipped). */
export const ffmpegPath: string | undefined = (() => {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    return execFileSync(cmd, ['ffmpeg'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim() || undefined;
  } catch {
    return undefined;
  }
})();

export function tempDir(prefix = 'edissistant-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function copyFixture(name: string, dir: string, as = name): string {
  const target = path.join(dir, as);
  fs.copyFileSync(path.join(fixtures, name), target);
  return target;
}
