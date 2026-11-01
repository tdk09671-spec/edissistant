import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { listProcesses } from '../../src/main/scene/processes';
import { recoverAbandonedRenderArtifacts } from '../../src/main/scene/recovery';
import { ELECTRON, HOST_SCRIPT, OUT, ROOT, SCENES, sleep, TOOLS } from './helpers';

// A hard kill of the app mid-render (the Windows report: a temp folder and a .partial.mov were left).
// A separate "app" process starts a real render and is killed with no chance to clean up; recovery then
// removes exactly the artifacts that app owned, and nothing else.

describe('crash recovery after a hard kill', () => {
  it('the abandoned job folder and partial output are removed; the export folder’s other files are untouched', async () => {
    const work = path.join(OUT, 'crash');
    fs.rmSync(work, { recursive: true, force: true });
    const outDir = path.join(work, 'exports');
    const stateDir = path.join(work, 'state');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'client_asset.mov'), 'the editor’s own file');
    fs.writeFileSync(path.join(outDir, 'trailer_v1.mov'), 'an earlier finished export');
    const output = path.join(outDir, 'trailer_v2.mov');
    const script = path.join(work, 'app.js');
    fs.writeFileSync(
      script,
      `
const fs = require('fs');
const { renderAnimation } = require(${JSON.stringify(path.join(ROOT, 'dist/main/scene/service.js'))});
const read = (p) => ({ path: p, data: fs.readFileSync(${JSON.stringify(SCENES)} + '/' + p) });
renderAnimation(
  { electron: ${JSON.stringify(ELECTRON)}, hostScript: ${JSON.stringify(HOST_SCRIPT)} },
  { entry: 'podcast-like/index.html', files: [read('podcast-like/index.html'), read('fonts/InterDisplay-ExtraBold.otf')], adapter: { kind: 'scene' }, width: 1920, height: 1080, deviceScale: 1, alpha: false, seed: 1 },
  { fps: 30, motionBlur: { samples: 1, shutter: 0.5 }, postCamera: false },
  { format: 'png-mov', output: ${JSON.stringify(output)}, ffmpeg: ${JSON.stringify(TOOLS.ffmpeg)}, ffprobe: ${JSON.stringify(TOOLS.ffprobe)} },
  { stateDir: ${JSON.stringify(stateDir)}, onProgress: (n) => n === 10 && console.log('RENDERING') }
).catch((e) => console.log('ERR', e.message));
`
    );
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('edissistant-scene-')));
    const app = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the render never started')), 60_000);
      app.stdout!.on('data', (c: Buffer) => {
        if (c.toString().includes('RENDERING')) {
          clearTimeout(t);
          resolve();
        }
      });
    });
    app.kill('SIGKILL'); // no cleanup code runs
    await new Promise((r) => app.once('exit', r));
    await sleep(1500); // the host notices its connection closed and exits on its own

    const left = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('edissistant-scene-') && !before.has(n) && n !== 'edissistant-scene-state');
    const partials = fs.readdirSync(outDir).filter((n) => n.includes('.edissistant-partial-'));
    expect(left.length, 'a job folder was left behind by the crash').toBe(1);
    expect(partials.length, 'a partial output was left behind by the crash').toBe(1);
    // The orphaned host noticed the app was gone and exited by itself (Linux: no process still points at
    // the abandoned job folder; on Windows this is a manual checklist item).
    if (process.platform === 'linux') {
      const stillThere = listProcesses().filter((p) => {
        try {
          return fs.readFileSync(`/proc/${p.pid}/cmdline`, 'utf8').includes(left[0]);
        } catch {
          return false;
        }
      });
      expect(stillThere.map((p) => `${p.pid} ${p.name}`)).toEqual([]);
    }

    const report = recoverAbandonedRenderArtifacts({ stateDir });
    expect(report.removedJobFolders).toEqual([path.join(os.tmpdir(), left[0])]);
    expect(report.removedPartials).toEqual([path.join(outDir, partials[0])]);
    expect(fs.readdirSync(outDir).sort()).toEqual(['client_asset.mov', 'trailer_v1.mov']);
    expect(fs.existsSync(output)).toBe(false);
    // Running it again finds nothing more to do.
    const again = recoverAbandonedRenderArtifacts({ stateDir });
    expect([again.removedJobFolders, again.removedPartials]).toEqual([[], []]);
  });
});
