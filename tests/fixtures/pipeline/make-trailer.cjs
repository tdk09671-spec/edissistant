#!/usr/bin/env node
// Builds a synthetic 30–60 s podcast-trailer rough cut for the end-to-end pipeline, with no
// downloads: speech is synthesised by FFmpeg's built-in flite filter, the picture is a waveform plate.
//
//   node make-trailer.cjs <outDir> [--fps=30000/1001] [--size=1920x1080] [--ffmpeg=/path/to/ffmpeg]
//
// Writes to <outDir>:
//   trailer.mp4            H.264 + AAC 48 kHz stereo, at --fps (default 29.97 = 30000/1001)
//   trailer.whisper.json   what whisper.cpp's -ojf would write for this audio: one entry per sentence,
//                          timed from the synthesised clips (sentence-level only; PR #1 interpolates words)
//   whisper-cli            stand-in engine: PR #1's fake-whisper-cli.cjs fed trailer.whisper.json
//   models/ggml-base.en.bin  placeholder "model" the stand-in accepts
//   script.json            the sentences: clip start/end and the measured speech onset (speechStart)
//
// The stand-in only replaces the speech-to-text step; FFmpeg audio extraction, sentence grouping
// and everything downstream run for real. It is POSIX-only (shebang wrapper).
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SENTENCES = [
  'This is The Cutting Room, the podcast for people who edit for a living.',
  'Last year, editors told us they spend 40% of their week on revisions.',
  'So we asked one question.',
  'What would you automate first?',
  'We talked to 120 editors in 14 countries.',
  'Their average turnaround dropped from 9 days to 4 days.',
  'First we listen, then we plan the story, then we animate it.',
  'New episodes every Tuesday.',
  'Subscribe now, and cut faster.',
];

const args = process.argv.slice(2);
const outDir = path.resolve(args.find((a) => !a.startsWith('--')) || 'trailer-out');
const opt = (name, fallback) => (args.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1] || fallback;
const fps = opt('fps', '30000/1001');
const [W, H] = opt('size', '1920x1080').split('x').map(Number);
const ffmpeg = opt('ffmpeg', 'ffmpeg');
const ffprobe = path.join(path.dirname(ffmpeg), ffmpeg === 'ffmpeg' ? 'ffprobe' : path.basename(ffmpeg).replace('ffmpeg', 'ffprobe'));

const LEAD = 0.8;
const GAP = 0.55;
const TAIL = 1.2;
const RATE = 48000;

fs.mkdirSync(path.join(outDir, 'models'), { recursive: true });
const work = fs.mkdtempSync(path.join(outDir, '.work-'));
const run = (cmd, a) => execFileSync(cmd, a, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const filterPath = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

// 1. One clip per sentence (flite → 48 kHz mono); exact durations from the sample count.
const clips = SENTENCES.map((text, i) => {
  const txt = path.join(work, `s${i}.txt`);
  const wav = path.join(work, `s${i}.wav`);
  fs.writeFileSync(txt, text);
  run(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `flite=textfile='${filterPath(txt)}':voice=slt`, '-ar', String(RATE), '-ac', '1', '-c:a', 'pcm_s16le', wav]);
  const file = fs.readFileSync(wav);
  let pos = 12;
  while (file.toString('ascii', pos, pos + 4) !== 'data') pos += 8 + file.readUInt32LE(pos + 4);
  const pcm = file.subarray(pos + 8, pos + 8 + file.readUInt32LE(pos + 4));
  const samples = pcm.length / 2;
  // flite pads each clip with silence; the speech starts at the first sample above -40 dBFS.
  let lead = 0;
  while (lead < samples && Math.abs(pcm.readInt16LE(lead * 2)) < 328) lead++;
  return { text, wav, duration: samples / RATE, lead: lead / RATE };
});

// 2. Concatenate with silences and record each sentence's true start/end.
let t = LEAD;
const timed = clips.map((c) => {
  // start/end: the clip (what the stand-in whisper output reports, like whisper's early segment
  // boundary); speechStart: where the speech actually begins in the audio.
  const s = { text: c.text, start: Number(t.toFixed(3)), end: Number((t + c.duration).toFixed(3)), speechStart: Number((t + c.lead).toFixed(3)) };
  t += c.duration + GAP;
  return s;
});
const total = t - GAP + TAIL;
const audio = path.join(work, 'speech.wav');
const inputs = [];
const labels = [];
const silence = (d) => {
  inputs.push('-f', 'lavfi', '-t', d.toFixed(6), '-i', `anullsrc=r=${RATE}:cl=mono`);
  labels.push(`[${labels.length}:a]`);
};
silence(LEAD);
clips.forEach((c, i) => {
  inputs.push('-i', c.wav);
  labels.push(`[${labels.length}:a]`);
  silence(i === clips.length - 1 ? TAIL : GAP);
});
run(ffmpeg, ['-v', 'error', '-y', ...inputs, '-filter_complex', `${labels.join('')}concat=n=${labels.length}:v=0:a=1[a]`, '-map', '[a]', '-c:a', 'pcm_s16le', audio]);

// 3. Picture: dark plate, title, live waveform of the speech. Synthetic, clearly labelled.
let font = '';
try {
  font = run('fc-match', ['-f', '%{file}', 'DejaVu Sans:bold']).trim();
} catch {
  font = '';
}
const draw = (text, y, size, color) =>
  font ? `,drawtext=fontfile='${filterPath(font)}':text='${text}':x=(w-tw)/2:y=${y}:fontsize=${size}:fontcolor=${color}` : '';
const video = path.join(outDir, 'trailer.mp4');
run(ffmpeg, [
  '-v', 'error', '-y',
  '-f', 'lavfi', '-i', `color=c=0x15171c:s=${W}x${H}:r=${fps}:d=${total.toFixed(3)}`,
  '-i', audio,
  '-filter_complex',
  `[1:a]aformat=channel_layouts=mono,showwaves=s=${Math.round(W * 0.8)}x${Math.round(H * 0.22)}:mode=cline:scale=sqrt:draw=full:rate=${fps}:colors=0xE9A94BFF[w];` +
    `[0:v][w]overlay=(W-w)/2:${Math.round(H * 0.6)}:shortest=1${draw('THE CUTTING ROOM', Math.round(H * 0.28), Math.round(H * 0.07), '0xF2F2F2')}${draw('synthetic test footage - speech by flite', Math.round(H * 0.4), Math.round(H * 0.025), '0x8A8F98')},format=yuv420p[v]`,
  '-map', '[v]', '-map', '1:a',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-r', fps,
  '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', String(RATE),
  '-t', total.toFixed(3), '-movflags', '+faststart',
  video,
]);

// 4. The transcript whisper.cpp would produce (sentence entries, no token timing).
const ms = (s) => Math.round(s * 1000);
const stamp = (s) => {
  const m = ms(s);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(m / 3600000))}:${p(Math.floor(m / 60000) % 60)}:${p(Math.floor(m / 1000) % 60)},${p(m % 1000, 3)}`;
};
const whisper = {
  systeminfo: 'synthetic',
  params: { model: 'models/ggml-base.en.bin', language: 'en', translate: false },
  result: { language: 'en' },
  transcription: timed.map((s) => ({ timestamps: { from: stamp(s.start), to: stamp(s.end) }, offsets: { from: ms(s.start), to: ms(s.end) }, text: ` ${s.text}` })),
};
fs.writeFileSync(path.join(outDir, 'trailer.whisper.json'), JSON.stringify(whisper, null, 2));
fs.writeFileSync(path.join(outDir, 'script.json'), JSON.stringify({ fps, width: W, height: H, duration: Number(total.toFixed(3)), sentences: timed }, null, 2));

// 5. Stand-in engine wired to this transcript, plus the placeholder model it checks for.
const fake = path.resolve(__dirname, '..', 'transcription', 'fake-whisper-cli.cjs');
const cli = path.join(outDir, 'whisper-cli');
fs.writeFileSync(cli, `#!/bin/sh\nexec "${process.execPath}" "${fake}" --fake-output="${path.join(outDir, 'trailer.whisper.json')}" "$@"\n`);
fs.chmodSync(cli, 0o755);
fs.writeFileSync(path.join(outDir, 'models', 'ggml-base.en.bin'), 'placeholder model for the stand-in engine');

fs.rmSync(work, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ video, duration: Number(total.toFixed(3)), sentences: timed.length })}\n`);
