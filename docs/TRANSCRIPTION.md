# Local transcription engine

Phase 2, Feature 1. A local-first transcription module: media → FFmpeg audio extraction → whisper.cpp →
word-timed, editable sentences → JSON / SRT / sequence-editor segments. Nothing leaves the machine, no paid
API is called, and nothing is downloaded by the app.

> **Status:** engine, IPC and TypeScript API are implemented and tested on Linux with real FFmpeg and a
> stand-in whisper-cli (see [What was tested](#what-was-tested)). **There is no UI yet**, and real Whisper
> inference has not been run on Windows. **GPU transcription is untested.**

## Pipeline

```
Renderer ──transcription:transcribe(jobId, {mediaPath, options})──▶ main: TranscriptionService (one job at a time)
   ▲                                                                  1. validate file (type, exists, non-empty)
   │ transcription:progress {jobId, stage, progress 0–1, message}     2. locate FFmpeg, whisper-cli, model
   │                                                                  3. fingerprint media → cache lookup ──hit──▶ done
   │                                                                  4. ffmpeg → 16 kHz mono PCM WAV (temp folder)
   │                                                                  5. whisper-cli -ojf (token timestamps) [GPU → CPU fallback]
   └──────────── TranscriptionResult {ok, transcript | error} ◀────── 6. tokens → words → sentences; cache; delete temp
```

| Stage | Overall progress |
| --- | --- |
| `queued`, `preparing` | 0 – 1 % |
| `extracting-audio` | 2 – 15 % (from FFmpeg `-progress`) |
| `transcribing` | 15 – 97 % (from whisper-cli `-pp`) |
| `grouping`, `done` | 98 – 100 % |
| `cache-hit` | jumps to 100 % |

## Code layout

| Path | Responsibility |
| --- | --- |
| `src/shared/transcription/` | Environment-neutral: types, errors, word utilities, sentence grouping and editing, JSON/SRT/segment export, whisper.cpp JSON parser. Imported by both processes. |
| `src/main/transcription/process.ts` | Shell-free child process runner with line streaming and abort → kill. |
| `src/main/transcription/tools.ts` | Finds FFmpeg / whisper-cli / models (settings → env → app folders → PATH). |
| `src/main/transcription/ffmpeg.ts` | Audio extraction, duration and progress parsing, error mapping. |
| `src/main/transcription/whisperCpp.ts` | `TranscriptionEngine` interface and the whisper.cpp adapter (args, progress, device detection, CPU fallback). |
| `src/main/transcription/cache.ts` | Media fingerprinting and the on-disk transcript cache. |
| `src/main/transcription/service.ts` | Job orchestration: queue, progress, cancellation, cache, temp cleanup. |
| `src/main/transcription/ipc.ts` | IPC channels. Registered in `main.ts`; bridged in `preload.ts`. |
| `src/renderer/lib/transcription.ts` | Renderer entry point: `startTranscription`, `transcriptToSegments`, `saveTranscriptFile`. |

`tsconfig.main.json` now compiles `src/main` and `src/shared` with `rootDir: src`, so output lands in
`dist/main/…` (unchanged paths) and `dist/shared/…`.

## Why whisper.cpp

- MIT-licensed C/C++ port of OpenAI Whisper with prebuilt Windows binaries, no Python runtime.
- CPU by default; the same CLI has CUDA / Vulkan builds on Windows and uses Metal on Apple Silicon.
- `--output-json-full` gives per-token timestamps and probabilities, which become word timing and confidence.
- Runs as a child process: no native Node module to rebuild for each Electron version, and a crash or
  cancel can't take down the app.

Other local engines (e.g. faster-whisper) can be added behind the `TranscriptionEngine` interface.

## Setup (Windows first)

The app never downloads binaries or models. Put them in place yourself:

1. **FFmpeg**: set `ffmpegPath` in Settings (existing field; the executable or its folder), or have `ffmpeg.exe` on `PATH`.
2. **whisper.cpp**: download a Windows x64 release zip from <https://github.com/ggml-org/whisper.cpp/releases>
   and unzip it to `%APPDATA%\edissistant\whisper\` (so `whisper-cli.exe` is directly inside it, or inside `bin\`).
   The plain CPU build is the safe default. CUDA builds are GPU variants and are untested with Edissistant.
3. **Model**: put one `ggml-*.bin` in `%APPDATA%\edissistant\models\`. Approximate sizes:

   | Model | Size | Notes |
   | --- | --- | --- |
   | `ggml-base.en.bin` | ~142 MB | Fast; fine for clean English dialogue |
   | `ggml-small.en.bin` / `ggml-small.bin` | ~466 MB | Good balance on CPU |
   | `ggml-large-v3-turbo-q5_0.bin` | ~550 MB | Best quality per MB; slower on CPU |
   | `ggml-large-v3-turbo.bin` | ~1.6 GB | Best quality; GPU recommended |

   whisper.cpp ships `models\download-ggml-model.cmd` for downloading them. **The app picks the largest installed
   model unless one is configured.**

Optional overrides in `%APPDATA%\edissistant\settings.json` (no UI yet; the settings screen keeps this block when it saves):

```json
{
  "ffmpegPath": "C:\\Tools\\ffmpeg\\bin",
  "transcription": {
    "whisperPath": "C:\\Tools\\whisper\\whisper-cli.exe",
    "modelsDirectory": "D:\\Models\\whisper",
    "model": "small.en",
    "language": "en",
    "device": "auto"
  }
}
```

Lookup order for each tool: settings → env var (`EDISSISTANT_FFMPEG_PATH`, `EDISSISTANT_WHISPER_PATH`) →
`%APPDATA%\edissistant\bin` and `\whisper` → `PATH` (+ `/opt/homebrew/bin`, `/usr/local/bin` on macOS, where
`brew install whisper-cpp` puts `whisper-cli`). A bare `main` executable (the old whisper.cpp name) is only
accepted from a folder you point to, never from `PATH`.

## Using it from the sequence editor

```ts
import { startTranscription, transcriptToSegments, saveTranscriptFile, editSentenceText } from '@/lib/transcription';

const job = startTranscription(project.source.path, { language: 'en' }, (p) => setProgress(p.progress));
// job.cancel() at any time → the promise rejects with code 'CANCELLED'
const { transcript, fromCache } = await job.result;

updateProject(project.id, (p) => ({ ...p, segments: transcriptToSegments(transcript) }));
await saveTranscriptFile(transcript, 'srt');   // or 'json'
```

Errors reject as `TranscriptionError` with a `code`:

| Code | Meaning |
| --- | --- |
| `INVALID_REQUEST` | Bad path, language or duplicate job id |
| `FILE_NOT_FOUND` / `UNSUPPORTED_FORMAT` | Missing, empty, or not one of `.mp4 .m4v .mov .mkv .webm .wav .mp3 .m4a .aac .flac` |
| `FFMPEG_NOT_FOUND` / `ENGINE_NOT_FOUND` / `MODEL_NOT_FOUND` | Tool or model missing or failed to start/load |
| `NO_AUDIO_STREAM` | No audio, empty audio, or the requested `audioTrack` doesn't exist |
| `EXTRACTION_FAILED` | FFmpeg couldn't read the file (damaged / unsupported codec) |
| `TRANSCRIPTION_FAILED` | whisper-cli failed or wrote unreadable output (`details` has the stderr tail) |
| `CANCELLED` | Cancelled, or the window closed / app quit while it ran |

`window.electronAPI.getTranscriptionStatus()` reports what was found (FFmpeg, engine and versions, models,
default model, and plain-language `problems`) without running anything.

### Options (`TranscriptionOptions`)

| Option | Default | |
| --- | --- | --- |
| `language` | `'auto'` | ISO code or auto-detect |
| `model` | settings → largest installed | Short name (`small.en`), file name, or absolute path |
| `device` | `'auto'` | `auto`: GPU-capable run, retry once with `-ng` on failure. `cpu`: always `-ng`. `gpu`: no fallback |
| `threads` | CPU cores − 1, max 8 | |
| `audioTrack` | `0` | 0-based audio stream, e.g. the second lav mic in a MOV |
| `dtwAlignment` | `false` | whisper.cpp DTW token alignment for tighter word timing (known model sizes only). whisper.cpp ≥ 1.8 turns flash attention on by default, which silently disables DTW. The app reads `whisper-cli --help` and adds `-nfa` (only with DTW) when the build has it; older builds have no `-nfa` and flash attention off. If DTW was still switched off, the transcript carries a warning. The normal path keeps flash attention. |
| `force` | `false` | Ignore the cache |
| `grouping` | `pauseThreshold 0.8 s`, `maxDuration 8 s`, `maxChars 160` | Sentence splitting |

### Transcript format (`edissistant.transcript`, version 1)

```jsonc
{
  "schema": "edissistant.transcript", "version": 1,
  "id": "<cache key>", "language": "en", "duration": 183.04,
  "media": { "path": "…", "name": "Take 1.mov", "size": 123, "modifiedAt": "…", "fingerprint": "…" },
  "engine": { "name": "whisper.cpp", "version": "1.x", "model": "small.en", "device": "cpu", "cpuFallback": false, "threads": 7 },
  "wordTiming": "word",            // or "interpolated" when the engine gave no token timing
  "sentences": [
    { "id": "s1", "start": 0.0, "end": 1.45, "text": "Welcome back to the edit.",
      "words": [ { "text": "Welcome", "start": 0.0, "end": 0.42, "confidence": 0.98 }, … ] }
  ],
  "createdAt": "…", "warnings": []
}
```

`parseTranscript()` validates a file and rejects other schemas or versions.

### Sentence start timing

- **The problem.** Without DTW, whisper.cpp pins the first token of each segment to the segment's start timestamp. Whisper usually puts that where the previous segment ended, before the pause, so a sentence could start most of a second before its first word. On Windows that put graphics up to ~0.9 s ahead of the speech.
- **Which starts are affected.** The parser marks those starts (`anchoredStarts`): the first word of a segment whose time equals the segment start, or every segment's first word when there is no token timing. DTW times are measured onsets and are never marked.
- **The fix** (timing version 3, after Windows validation round 2). The service moves each marked start to the speech onset it measures in the 16 kHz WAV that whisper read.
  - **Evidence is speech, not volume.** The service measures the speech band (300–3400 Hz) in 10 ms frames, against the local background: the quietest 100 ms around the start, from 1 s before it. A music bed or steady noise is background, so speech starting over it is still found, and the bed alone never counts as speech already in progress. That was the bug that left the first sentence 0.92 s early with no warning.
  - **An onset has to look like speech.** The band has to rise at least +6 dB over the background, rise out of quieter frames, and stay up for 150 ms of the next 400 ms. A kick drum or a lip smack doesn't qualify.
  - **Quiet lead-in consonants** (f, s, sh, th, h) are found in a 2.5–7 kHz band, up to 250 ms before the vowel.
  - **The search runs up to 3 s into the segment**, not just to whisper's first-token end, which often comes before the real onset. That miss caused up to 0.92 s early on clean speech and 2.03 s after a pause. Words that would end before the new start are spread again from it.
  - No start moves before the previous word. No fixed offset is applied. Measured (DTW) word times and every word end are untouched.
- **Every marked start ends in exactly one state**, counted in `transcript.timing`:
  - `refinedStarts`: moved to a clear onset.
  - `confirmedStarts`: the audio confirms the engine's time.
  - `uncertainStarts`: weak or ambiguous evidence: music or noise under the speech (accurate to about ±0.1 s), an overlapping voice, or speech that runs on from the previous word. The start is the best guess.
  - `uncheckedStarts`: no onset found; left as the engine gave it.
  - Uncertain and unchecked starts are flagged on the word (`startUncertain`), and the transcript warns: "N sentence start(s) couldn't be verified against the audio …". The app never presents those as precisely synchronised.
- **Measured** on synthetic speech and on real flite TTS, with truth taken from the dry stems (`tests/unit/transcription/onsetScenes.test.ts`):
  - Clean speech, with pauses up to 2.5 s and lead-ins down to −30 dB: within 10 ms (synthetic) and 26 ms (TTS).
  - With a music bed at −12 or −6 dB, every start is within 50 ms or flagged.
  - An overlapping voice is always flagged.
- **Missing speech** (Windows validation round 2: whisper.cpp 1.9.5, small.en with `-nfa`, dropped the last 8 s of a 40 s clip with no warning; base.en was fine). After every run the service looks for speech in the audio that no word covers: the speech band at least +8 dB over the file's floor, at least 1 s of it.
  - A **DTW run** that left speech without text is redone without DTW. If that covers more, it is used, with a warning naming the model and the spans, and `timing.dtwFallback = { reason: 'truncated', dtwEnd }`.
  - Speech that still has no text is **transcribed again** from a clip of just that audio, up to 5 spans and without DTW, and the words are added (`coverage.recovered`, with a warning).
  - Anything still missing is listed in `coverage.gaps`, with `coverage.complete = false` and a warning. A transcript is never accepted silently with dialogue missing.
  - DTW stays opt-in: it is used only when a request asks for it.
- **Best accuracy.** Use DTW (`dtwAlignment`). On whisper.cpp 1.8 or newer, the app adds `-nfa` so DTW isn't switched off.

### Editing sentences

Pure, immutable helpers in `src/shared/transcription/sentences.ts`:

- `editSentenceText(sentence, text)`: fixes a transcript line while **keeping word timing**. Unchanged words keep their
  engine timestamps (matched by a word-level diff), corrected words take the timing of the word they replace, and
  inserted words are spread across the gap. The sentence's in/out points don't move.
- `splitSentence`, `mergeWithNext`, `retimeSentence` (scales word times to a new span).
- `groupWordsIntoSentences(words, options)` re-groups at any time.

Grouping breaks after `. ! ? …` (and CJK `。！？`), except after common abbreviations (`Dr.`, `Mr.`, `e.g.` …), at pauses
≥ `pauseThreshold`. Sentences over `maxDuration`/`maxChars` are then split knowing the whole sentence: at a comma or
other clause break with at least three words on each side, otherwise into even parts (preferring the longest pause
between equally good points), so no one-word fragments are left. Words and their timing are never changed.

### SRT export

`transcriptToSrt(transcript, { maxCharsPerLine: 42, maxLines: 2, minDuration: 0.7 })`: sentences that don't fit two
lines are split into several cues **at word boundaries using word times**; lines are balanced; short cues are extended
into following silence but never overlap the next cue. The output parses with the app's existing caption importer.

## Caching

- Location: `%APPDATA%\edissistant\transcripts\<key>.json` (atomic writes; oldest pruned beyond 500 entries).
- Key = media fingerprint + whisper-cli binary (name, size, mtime) + model file (name, size, mtime) + language +
  audio track + DTW flag + schema version + timing version. Grouping options are not in the key: cached words are re-grouped on load.
  The timing version (`TIMING_VERSION`, now 2) was bumped when anchored sentence starts started being refined from the audio,
  so transcripts cached before that are made again.
- Media fingerprint = size + mtime + SHA-256 of 1 MiB samples at 0 %, 25 %, 50 %, 75 % and the end, so multi-GB camera
  files are fingerprinted almost instantly. Renaming or moving a file keeps its cache entry; re-exporting it (new
  mtime) or replacing the model or engine invalidates it.
- `clearTranscriptCache()` empties it. Cancelled and failed jobs never write to it.

## GPU and CPU fallback

- `device: 'cpu'` passes `-ng`. `auto` (default) runs whisper-cli without `-ng`, so a GPU build may use its GPU; if
  that run fails for a reason a CPU run could fix, it's retried once with `-ng`, and the transcript records
  `cpuFallback: true` with a warning.
- `engine.device` comes from whisper.cpp's own log (`whisper_backend_init_gpu: using CUDA0 backend` → `gpu`;
  `no GPU found` or `-ng` → `cpu`; otherwise `unknown`). We don't guess.
- GPU transcription and device detection (`CUDA0`) were verified on Windows with the whisper.cpp 1.9.5 CUDA 12.4 build
  on an RTX 3070. **The GPU → CPU fallback has not been triggered on real hardware**; it's covered only by the
  stand-in engine, which prints the same log lines.

## Windows notes

- Processes are spawned with `windowsHide: true` and without a shell, so paths with spaces, `&` or quotes are safe.
- whisper-cli reads its arguments in the Windows ANSI code page, so any non-ASCII path argument is mangled (whisper.cpp
  1.9.5 crashes on `C:\…\modèles\…` and can't find `…\日本\…`). The engine therefore only passes ASCII paths:
  - normally it runs in its temp folder and passes the WAV and output as short relative names, and an ASCII model path as is;
  - if the model path isn't ASCII (e.g. under `C:\Users\José`), it runs in the model's folder, passes the model's file
    name, and reaches the WAV/output by a relative path (`..\..\Local\Temp\…` climbs out of the Unicode part);
  - if that still isn't ASCII (a non-ASCII model file name, or a Unicode temp folder on another drive), it uses a
    temporary hard link with an ASCII name in the temp folder. The model file itself is never moved, copied or renamed;
  - if no hard link can be made (different drive, FAT/exFAT), it fails with `MODEL_NOT_FOUND` and says how to fix it.
  whisper-cli itself, FFmpeg and media files work from Unicode folders. Tested on Windows 11 with whisper.cpp 1.9.5
  (CPU and CUDA builds) under a simulated `Zoë José 日本` user folder.
- Cancelling uses `ChildProcess.kill()` (TerminateProcess on Windows). Closing the window or quitting the app cancels
  running jobs, and quitting waits (up to 5 s) for them to delete their temp audio.
- Extraction writes a temporary 16 kHz WAV (~115 MB per hour of media) in `%TEMP%`; it's deleted when the job ends.

## What was tested

Linux (container), Node 22.22, FFmpeg 6.1.1, Electron 45 under `xvfb-run`:

- `npm run typecheck`, `npm run build`: pass.
- `npm run test:unit`: 133 tests (36 existing + 97 new), all passing. The new tests cover grouping, editing, SRT/JSON,
  the whisper.cpp JSON parser (synthetic `-ojf` fixture in whisper.cpp's exact layout, including bare `nan`, control
  tokens, `[BLANK_AUDIO]`, sub-word merges, CJK, DTW), tool discovery (Windows `.exe`/`;` PATH logic simulated), cache
  and fingerprinting, **real FFmpeg extraction** from MP4, MOV (two audio tracks), WAV and MP3, no-audio and damaged
  files, and the whole service with a stand-in `whisper-cli`: progress order, cache hit/miss/move/force, grouping on
  cache hits, GPU→CPU fallback, cancellation of running and queued jobs, temp cleanup.
- `npx playwright test` (under `xvfb-run`): 19 tests (18 existing + 1 new IPC spec), all passing.

The stand-in `tests/fixtures/transcription/fake-whisper-cli.cjs` accepts the same flags, checks the WAV is 16 kHz mono
16-bit, prints whisper.cpp's progress and backend lines, and writes canned `-ojf` output. The flags and JSON layout were
checked against the whisper.cpp source (`examples/cli/cli.cpp`), **not against a running whisper.cpp binary.**

## Still requires testing (Windows first)

1. Real whisper.cpp Windows CPU build + a real model on real interview footage: accuracy, word timing against the
   waveform, speed (real-time factor) for base/small/large-v3-turbo.
2. The flag set (`-ojf -pp -l -t -ng -of -f`, optional `-dtw` and, with DTW on whisper.cpp ≥ 1.8, `-nfa`) on the exact whisper.cpp release you ship.
3. A CUDA (or Vulkan) build on an NVIDIA GPU: device detection, speed, and the fallback when the driver is missing.
4. A real (not simulated) non-ASCII Windows user account, network drives, and very long files (2 h+).
5. Cancel/quit while transcribing on Windows (no orphaned `whisper-cli.exe` or `ffmpeg.exe`).
6. macOS: Homebrew `whisper-cli` discovery from a Finder-launched app, Metal device detection.
7. Running `tests/e2e/transcription.spec.ts` on Windows: it is skipped there because the stand-in engine is a Node
   script that Windows can't run directly.

## Not included yet

- UI (progress panel, transcript editor, import into segments). The UI design is untouched.
- Model or binary download/management, VAD-based silence trimming, speaker diarization, translation.
