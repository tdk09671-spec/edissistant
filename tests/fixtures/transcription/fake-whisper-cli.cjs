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
const finish = () => {
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
