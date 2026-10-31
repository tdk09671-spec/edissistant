# Testing

Run everything with one command:

```bash
npm test          # unit tests, then production build + end-to-end tests
npm run test:unit # Vitest only (fast, no Electron; runs anywhere)
npm run test:e2e  # builds, then drives the real Electron app with Playwright
```

## How it works

- **Unit tests** (`tests/unit`, Vitest) cover pure renderer logic. `dataProvider.test.tsx` uses jsdom.
- **End-to-end tests** (`tests/e2e`, Playwright `_electron`) launch the **built** app (`dist/main/main.js`) through `tests/e2e/launcher.cjs`. The launcher points Electron's `appData`/`userData` at a fresh folder under `test-results/` for each test. It refuses to start unless `EDISSISTANT_TEST_APPDATA` is set to a folder outside the real `appData`, so tests can never read, write or migrate real user data.
- **Fixtures** (`tests/fixtures`) are synthetic: a 3-second FFmpeg test pattern (`sample.mp4`) and a two-cue `sample.srt`. `tests/fixtures/transcription/` adds 1–2 s FFmpeg tones (`tone.wav`, `tone.mp3`, `clip.mov` with two audio tracks, `no-audio.mp4`), synthetic whisper.cpp JSON output, and `fake-whisper-cli.cjs`, a stand-in for whisper.cpp so tests need no model download. Never add client media.
- **Transcription tests** (`tests/unit/transcription`) use the real FFmpeg on `PATH` when present; FFmpeg-dependent tests are skipped otherwise.
- On failure, Playwright keeps a trace and a screenshot in `test-results/` (`npx playwright show-trace <trace.zip>`). An HTML report goes to `playwright-report/`.
- The E2E tests need a desktop session. Cloud or headless Linux sessions can run `npm run test:unit`, `npm run typecheck` and `npm run build`. Running E2E there would need `xvfb-run` and is untested.

## Test log v4: end-to-end integration (Linux, 2026-11-01)

This is branch `feature/end-to-end-integration`, verified from a **clean clone** of the pushed branch. Its base is `main` `ec16bac`, with these merged in:
- PR #1 `ab032ef`
- PR #2 `178c793`
- PR #3 `3357fa7`
- #5 `c8a80b2`

Environment: Linux cloud container, Node 22, FFmpeg 6.1.1, Electron 45, with E2E under `xvfb-run -a`. **Windows revalidation is pending.**

| Command | Result |
| --- | --- |
| `npm ci`, `npm run typecheck`, `npm run build` | pass |
| `npm run test:unit` | **429 passed, 2 skipped** (42 files) |
| `xvfb-run -a npx playwright test` as a **non-root** user | **34/34 passed** |
| the same, as root | 30 passed, 4 failed (PR #1 `launcher.spec.ts`: Electron refuses root without `--no-sandbox`) |

- **Windows findings on `6e35122`**, each fixed with regression tests that fail without the fix (see [docs/INTEGRATION.md](docs/INTEGRATION.md)):
  - concept/mode INVALID_SPEC
  - DTW vs flash attention
  - early sentence starts
  - font message
- **The E2E slice**, through the real UI:
  - It runs the Windows Bug 1 sequence: Captions mode, then Kinetic headline, then approve, then render.
  - It checks sentence starts against each sentence's speech onset measured in the audio (within 30 ms).
  - It checks each full-frame graphic's first and last frame at 30000/1001.
- **Transcription in all tests is mocked:** PR #1's stand-in `whisper-cli` writes canned whisper.cpp JSON. FFmpeg audio extraction, onset refinement, grouping, planning, rendering and export are real. **Real whisper.cpp, its GPU path and the `-nfa` behaviour were not run here.**

## Test log v3: local transcription (2026-10-28)

Linux cloud container, Node 22.22.0, FFmpeg 6.1.1, Electron 45 (E2E under `xvfb-run -a`). Not yet run on Windows.

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run build` | pass |
| `npm run test:unit` | **133/133** (36 existing + 97 new, 0 skipped) |
| `xvfb-run -a npx playwright test` | **19/19** (18 existing + new `transcription.spec.ts`) |

New unit files: `words`, `sentences`, `exporters`, `whisperCppJson`, `tools`, `cache`, `ffmpeg` (real FFmpeg: MP4, MOV, WAV, MP3, track selection, no-audio, damaged file, cancel), `whisperCpp` (args, device detection, GPU→CPU fallback, error mapping, kill on cancel), `service` (end-to-end with real FFmpeg and the stand-in engine: progress, cache, cancellation, cleanup), `rendererAdapter` (segments, IPC wrapper).

Not tested: real whisper.cpp inference, any GPU, Windows. The full list is in [docs/TRANSCRIPTION.md](docs/TRANSCRIPTION.md#still-requires-testing-windows-first). `transcription.spec.ts` is skipped on Windows (its stand-in engine is a Node script that needs a shebang).

## Test log v2 (2026-10-28)

Windows 11 Pro 10.0.26300, Node 22.14.0, Electron 45.1.0, Vitest 5.0.5, Playwright 1.64.1.
`npm test` was run twice in a row: **36/36 passed both times** (19 unit + 17 E2E, about 45 s for E2E).

### Unit (19)

| File | Covers |
| --- | --- |
| `time.test.ts` | Timecode/clock/precise formatting, `parseTime` (seconds, M:SS, H:MM:SS, timecode, invalid) |
| `captions.test.ts` | SRT fixture, WebVTT (BOM, CRLF, cue settings, tags), plain transcript, empty VTT, SRT and CSV export with escaping |
| `project.test.ts` | Segment clamping, sorting, playhead lookup, media URLs from Windows paths, file names, export defaults |
| `migration.test.ts` | **Regression:** legacy folder migration (`src/main/migration.ts`): `Local State` alone doesn't block it, empty/missing folders, existing data never overwritten, deleted items not restored, backups and secrets preserved. Verified to fail with the old `Local State` check. |
| `dataProvider.test.tsx` | **Regression:** a save requested before the initial load must not overwrite stored data. Verified to fail without the fix. |

### End-to-end (17)

| Area | Test | Reference in test log v1 |
| --- | --- | --- |
| Launch | Isolated data folder, preload API, no console errors | — |
| Navigation | Sidebar: Projects, Presets, Home, Settings | — |
| Projects | New Project dialog creates, opens, saves to disk | F14, F15 |
| Projects | Card menu: rename, duplicate, delete (cancel keeps it; confirm deletes) | F16, v1 §6 |
| Presets | Wizard: required name, URL validation, input kept on Back/Continue, saved to disk | F08–F13 |
| Presets | Card menu: duplicate, delete with confirmation | v1 §6 |
| Video | Media protocol load, duration, seek | F01, F02 |
| Revisions | N adds a segment, Ctrl+Z undoes, Ctrl+Shift+Z redoes, all persisted | F06, F07, v1 §6 |
| Revisions | Review: add comment, resolve, reopen, save version, restore version | F17, v1 §6 |
| Persistence | Project, preset and settings toggle survive a restart; `.bak` written on second save | F18–F21 |
| Recovery | Corrupt `presets.json` falls back to `.bak` | — |
| Recovery | Corrupt file and `.bak`: app starts empty, files not overwritten on launch | — |
| Recovery | Valid empty file is trusted; `.bak` is not auto-loaded (documents current behaviour) | — |
| Migration | Legacy `edissisant` folder moved when no current data | — |
| Migration | Existing current data wins; legacy left untouched | — |
| Migration | **Regression:** `Local State` alone no longer blocks migration; legacy `.bak` files carried over | — |
| Migration | Deleted presets/projects are not restored from the legacy folder | — |
| Secrets | Plaintext API key moved to `secrets.bin`, removed from `settings.json` | F03–F05, F20 |

### Defect fixed in this round

- **Startup save race** (`state/DataProvider.tsx`): saves did not wait for the initial load, so an early save could write empty lists over stored data. Saves now wait for loading to finish. Covered by `dataProvider.test.tsx`.

### Known behaviours, documented and not changed

- `.bak` is only used when the main file can't be parsed. A deliberately emptied list is trusted.

### Still not covered

Export CSV/SRT through the OS save dialog, caption import through the UI, OS file pickers (source video, logo, reference files), inline header rename, search/filter/sort, split/in/out/J/K/L shortcuts, Inspector edits, Settings API key save/remove through the UI, the other settings toggles, the auto-save-off flow, keyboard-only navigation, the layout audit at multiple window sizes, `npm run dev`, packaged builds, macOS/Linux.

## Animation rendering tests (Linux 2026-10-28, Windows 2026-10-29)

Linux cloud container, Node 22.22, FFmpeg 6.1.1, Electron 45 under `xvfb-run -a`.

**Windows 11 (2026-10-29)**: `npm run test:unit` 137/137 (130 + 7 regression tests from the Windows
validation), `npx playwright test` 27/27, typecheck and build pass. Results, fixes and measurements:
[docs/RENDERING.md](docs/RENDERING.md#windows-11-2026-10-29). Manual import into Premiere Pro (18/18),
After Effects (5/5) and DaVinci Resolve (5/5) passed: [docs/RENDERING.md](docs/RENDERING.md#editing-applications-manual).

- `npm run test:unit`: 130/130 (36 existing + 94 new in `tests/unit/animation` and `tests/unit/render`). Render tests use real FFmpeg with a synthetic frame source and are skipped when `ffmpeg`/`ffprobe` aren't on `PATH`.
- `xvfb-run -a npx playwright test`: 27/27 (18 existing + 9 in `tests/e2e/rendering.spec.ts`, which render through the real sandboxed engine and verify outputs by decoding them with FFmpeg).
- Fixtures: `tests/fixtures/animation/*.json` (specs only, no media).

Coverage, performance numbers, known limitations and the checks still needed are listed in [docs/RENDERING.md](docs/RENDERING.md#test-status).
