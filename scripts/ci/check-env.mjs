#!/usr/bin/env node
// Prints the tool versions a test run depends on, and (with flags) fails when something the run
// must exercise is missing, so FFmpeg-dependent tests can't silently skip on a misconfigured runner.
//
//   node scripts/ci/check-env.mjs                     report only
//   node scripts/ci/check-env.mjs --require-media     FFmpeg + FFprobe with libx264, prores_ks, aac
//                                                     and the flite filter; the Inter font (Linux)
//   node scripts/ci/check-env.mjs --require-non-root  fail when running as root (Electron's sandbox)

import { execFileSync } from 'node:child_process';
import os from 'node:os';

const args = new Set(process.argv.slice(2));
const problems = [];

const run = (cmd, argv) => {
  try {
    return execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
};
const firstLine = (text) => (text ?? '').split(/\r?\n/)[0].trim();

console.log(`OS:      ${os.type()} ${os.release()} (${process.platform} ${process.arch})`);
console.log(`Node:    ${process.version}`);
if (process.platform !== 'win32') console.log(`User id: ${process.getuid()}`);

const ffmpeg = run('ffmpeg', ['-hide_banner', '-version']);
const ffprobe = run('ffprobe', ['-hide_banner', '-version']);
console.log(`FFmpeg:  ${ffmpeg ? firstLine(ffmpeg) : 'not found'}`);
console.log(`FFprobe: ${ffprobe ? firstLine(ffprobe) : 'not found'}`);

if (args.has('--require-media')) {
  if (!ffmpeg) problems.push('FFmpeg is not on PATH: the FFmpeg-dependent tests would be skipped.');
  if (!ffprobe) problems.push('FFprobe is not on PATH: the FFmpeg-dependent tests would be skipped.');
  if (ffmpeg) {
    const encoders = run('ffmpeg', ['-hide_banner', '-encoders']) ?? '';
    for (const e of ['libx264', 'prores_ks', 'aac']) if (!new RegExp(`\\s${e}\\s`).test(encoders)) problems.push(`FFmpeg has no ${e} encoder.`);
    const filters = run('ffmpeg', ['-hide_banner', '-filters']) ?? '';
    if (!/\sflite\s/.test(filters)) problems.push('FFmpeg has no flite filter: the end-to-end pipeline test would be skipped.');
  }
  if (process.platform === 'linux') {
    // The pipeline E2E preset names Inter; brand fonts are strict, so it must be installed.
    const font = firstLine(run('fc-match', ['-f', '%{family}', 'Inter:bold']));
    console.log(`Inter:   ${font || 'fontconfig not available'}`);
    if (!/^Inter\b/.test(font)) problems.push('The Inter font is not installed (apt package fonts-inter): the pipeline E2E would fail with FONT_NOT_FOUND.');
  }
}

if (args.has('--require-non-root') && process.platform !== 'win32' && process.getuid() === 0) {
  problems.push('Running as root: Electron refuses to start as root unless its sandbox is disabled. Run tests as a normal user.');
}

if (problems.length) {
  console.error(`\n${problems.map((p) => `✗ ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('\nEnvironment OK.');
