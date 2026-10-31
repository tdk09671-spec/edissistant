#!/usr/bin/env node
// Stand-in for whisper.cpp's whisper-cli, used by unit tests so no model download is needed.
// It accepts the same flags the engine adapter passes, checks the WAV FFmpeg produced is
// 16 kHz mono PCM, prints progress/backend lines the way whisper.cpp does, and writes a
// canned -ojf JSON file.
//
// Test-only flags (must come first): --fake-mode=<normal|gpu-fail|gpu-ok|slow|crash|no-output>
//   --fake-output=<json fixture>  --fake-record=<file that receives the argv as JSON lines>
//   --fake-help=<modern|legacy>: modern (default) behaves like whisper.cpp >= 1.8: --help lists
//   -nfa, flash attention is on by default and -dtw without -nfa logs the real "disabling" warning
//   and writes no DTW times. legacy has no -nfa: passing it prints "error: unknown argument", the
//   usage text and exits 0 without output, as the real CLI does. lying lists -nfa in --help but
//   rejects it like legacy (to test the retry).
//   --fake-mode=bursts: instead of a canned file, "recognises" the audio it is given: each burst of
//   sound is a sentence, split into ~0.4 s words. Segments start where the previous one ended (like
//   whisper.cpp without DTW); with DTW on, tokens carry the true word onsets in t_dtw. Works on any
//   clip, so a second pass over part of the audio gets times relative to that part.
//   --fake-truncate-nfa=<model substring>:<seconds>: with -nfa and a model whose file name contains
//   the substring, drop every segment starting after <seconds> (whisper.cpp 1.9.5 small.en with
//   flash attention off stopped 8 s early in Windows validation round 2).
//   --fake-truncate=<seconds>: drop segments after <seconds> whatever the flags (bursts mode).
//   --fake-silent-under=<seconds>: inputs shorter than this produce no text (a failed second pass).
'use strict';
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const fake = {};
while (argv[0] && argv[0].startsWith('--fake-')) {
  const [key, value] = argv.shift().slice(7).split('=');
  fake[key] = value;
}
const mode = fake.mode || 'normal';
if (fake.record) fs.appendFileSync(fake.record, JSON.stringify(argv) + '\n');

if (argv.includes('--version')) {
  process.stdout.write('whisper.cpp version: 0.0.0-fake\n');
  process.exit(0);
}

const helpMode = fake.help || 'modern';
const modern = helpMode === 'modern';
const listsNfa = helpMode !== 'legacy';
const usage = () => {
  const lines = ['usage: whisper-cli [options] file0 file1 ...', '  -h,        --help                 [default] show this help message and exit', '  -ojf,      --output-json-full     [false  ] include more information in the JSON file', '  -dtw MODEL --dtw MODEL            [       ] compute token-level timestamps', '  -fa,       --flash-attn           [' + (modern ? 'true   ' : 'false  ') + '] enable flash attention'];
  if (listsNfa) lines.push('  -nfa,      --no-flash-attn        [false  ] disable flash attention');
  process.stderr.write(lines.join('\n') + '\n');
};
if (argv.includes('--help') || argv.includes('-h')) {
  usage();
  process.exit(0);
}
if (!modern && argv.includes('-nfa')) {
  process.stderr.write('error: unknown argument: -nfa\n');
  usage();
  process.exit(0);
}
const flashAttn = modern && !argv.includes('-nfa');
const dtwRequested = argv.includes('-dtw');

const opt = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const noGpu = argv.includes('-ng');
const model = opt('-m');
const input = opt('-f');
const outBase = opt('-of');

if (!model || !fs.existsSync(model)) {
  process.stderr.write(`error: model file not found '${model}'\n`);
  process.exit(2);
}
if (!input || !fs.existsSync(input)) {
  process.stderr.write(`error: input file not found '${input}'\n`);
  process.exit(2);
}
const wav = fs.readFileSync(input);
const channels = wav.readUInt16LE(22);
const rate = wav.readUInt32LE(24);
const bits = wav.readUInt16LE(34);
if (wav.toString('ascii', 0, 4) !== 'RIFF' || channels !== 1 || rate !== 16000 || bits !== 16) {
  process.stderr.write(`error: failed to read audio file '${input}' (expected 16 kHz mono s16, got ${rate} Hz ${channels} ch ${bits} bit)\n`);
  process.exit(4);
}

if (flashAttn && dtwRequested) process.stderr.write('whisper_init_with_params_no_state: dtw_token_timestamps is not supported with flash_attn - disabling\n');
process.stderr.write(`whisper_init_with_params_no_state: flash attn = ${flashAttn ? 1 : 0}\n`);
process.stderr.write(`whisper_init_with_params_no_state: use gpu    = ${noGpu ? 0 : 1}\n`);
if (!noGpu) {
  if (mode === 'gpu-fail') {
    process.stderr.write('ggml_cuda_init: failed to initialize CUDA: no CUDA-capable device is detected\n');
    process.stderr.write('error: failed to initialize whisper context\n');
    process.exit(1);
  }
  process.stderr.write(mode === 'gpu-ok' ? 'whisper_backend_init_gpu: using CUDA0 backend\n' : 'whisper_backend_init_gpu: no GPU found\n');
}
if (mode === 'crash') {
  process.stderr.write('GGML_ASSERT: something went wrong\n');
  process.exit(3);
}

const step = mode === 'slow' ? 150 : 0;
let progress = 0;
const tick = () => {
  process.stderr.write(`whisper_print_progress_callback: progress = ${String(progress).padStart(3)}%\n`);
  if (progress >= 100) return finish();
  progress += 10;
  setTimeout(tick, step);
};
// Burst "recognition" for --fake-mode=bursts (see the header).
function burstTranscript() {
  // Samples start after the "data" chunk header (FFmpeg writes a LIST chunk before it).
  let pos = 12;
  while (pos + 8 <= wav.length && wav.toString('ascii', pos, pos + 4) !== 'data') pos += 8 + wav.readUInt32LE(pos + 4) + (wav.readUInt32LE(pos + 4) % 2);
  const data = wav.subarray(pos + 8);
  const n = Math.floor(data.length / 2);
  const frame = 160; // 10 ms at 16 kHz
  const env = [];
  for (let f = 0; f * frame < n; f++) {
    let sum = 0;
    const end = Math.min(n, (f + 1) * frame);
    for (let i = f * frame; i < end; i++) {
      const v = data.readInt16LE(i * 2);
      sum += v * v;
    }
    env.push(Math.sqrt(sum / Math.max(1, end - f * frame)));
  }
  const loud = env.map((e) => e > 600);
  const sentences = [];
  let open = null;
  let quiet = 0;
  loud.forEach((on, f) => {
    if (on) {
      if (!open) open = { a: f, b: f + 1 };
      open.b = f + 1;
      quiet = 0;
    } else if (open && ++quiet > 40) {
      sentences.push(open);
      open = null;
    }
  });
  if (open) sentences.push(open);
  const seconds = n / 16000;
  const truncateNfa = fake['truncate-nfa'] ? fake['truncate-nfa'].split(':') : null;
  let cutoff = fake.truncate ? Number(fake.truncate) : Infinity;
  if (truncateNfa && argv.includes('-nfa') && path.basename(model).includes(truncateNfa[0])) cutoff = Math.min(cutoff, Number(truncateNfa[1]));
  if (fake['silent-under'] && seconds < Number(fake['silent-under'])) cutoff = -1;
  const useDtw = dtwRequested && !flashAttn;
  const ms = (s) => Math.round(s * 1000);
  const transcription = [];
  let prevEnd = 0;
  let k = 0;
  for (const s of sentences) {
    const a = s.a / 100;
    const b = s.b / 100;
    if (a > cutoff) break;
    const count = Math.max(1, Math.round((b - a) / 0.4));
    const segFrom = transcription.length ? prevEnd : Math.floor(a);
    const segTo = Math.min(seconds, b + 0.1);
    const tokens = [{ text: '[_BEG_]', offsets: { from: ms(segFrom), to: ms(segFrom) }, p: 0.99, t_dtw: -1 }];
    const words = [];
    for (let i = 0; i < count; i++) {
      const text = ` word${++k}${i === count - 1 ? '.' : ''}`;
      words.push(text.trim());
      // Token offsets spread over the whole segment (early start); DTW gets the true onsets.
      const from = segFrom + ((segTo - segFrom) * i) / count;
      const to = segFrom + ((segTo - segFrom) * (i + 1)) / count;
      tokens.push({ text, offsets: { from: ms(from), to: ms(to) }, p: 0.9, t_dtw: useDtw ? Math.round((a + ((b - a) * i) / count) * 100) : -1 });
    }
    transcription.push({ offsets: { from: ms(segFrom), to: ms(segTo) }, text: ' ' + words.join(' '), tokens });
    prevEnd = segTo;
  }
  return JSON.stringify({ result: { language: 'en' }, transcription });
}

const finish = () => {
  if (mode === 'bursts') {
    fs.writeFileSync(`${outBase}.json`, burstTranscript());
    process.stdout.write('[bursts]\n');
    return;
  }
  if (mode !== 'no-output') {
    const source = fake.output || path.join(__dirname, 'whisper-full.json');
    let json = fs.readFileSync(source, 'utf8');
    // DTW switched off by flash attention: whisper.cpp writes t_dtw = -1 for every token.
    if (flashAttn && dtwRequested) json = json.replace(/"t_dtw":\s*-?\d+(\.\d+)?/g, '"t_dtw": -1');
    fs.writeFileSync(`${outBase}.json`, json);
  }
  process.stdout.write('[00:00:00.000 --> 00:00:01.800]   Welcome back to the edit.\n');
};
tick();
