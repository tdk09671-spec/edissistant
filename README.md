# Edissistant

AI-powered production assistant for professional video editors — a Windows desktop app (Electron + React + TypeScript) for planning segments, directing cuts, reviewing with timestamped comments, and keeping each client's style consistent through reusable presets.

> **Status: v0.1.0 development baseline.** This is a safe starting point for development, **not** a production or commercial release. AI planning, rendering and packaging are not implemented yet. A local transcription engine (FFmpeg + whisper.cpp) exists without a UI; see [docs/TRANSCRIPTION.md](docs/TRANSCRIPTION.md). See [Test status](#test-status).

## Requirements

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 22.14.0 (see `.nvmrc`) | Node ≥ 22 expected |
| npm | 11.x | Comes with Node; `package-lock.json` is committed |
| Git | any recent | |
| OS | Windows 10/11 (primary target) | Build and type-check also work on Linux/macOS; the app is only tested on Windows |
| FFmpeg | optional | Needed for transcription and for the FFmpeg unit tests (skipped without it). Not needed to build or run |
| whisper.cpp + model | optional | Only for real transcription. Not downloaded by the app; see [docs/TRANSCRIPTION.md](docs/TRANSCRIPTION.md) |

Electron (45.x) is installed by npm as a dependency, so you don't need a separate install.

## Setup

```bash
git clone <repo-url> edissistant
cd edissistant
npm ci
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run typecheck` | Type-checks the renderer (`tsconfig.json`) and main process (`tsconfig.main.json`) |
| `npm run build` | Production build: Vite → `dist/renderer`, tsc → `dist/main` |
| `npm start` | Builds, then launches the built app in Electron |
| `npm run dev` | Vite dev server on :5173 + Electron with `--dev` (hot reload for the renderer) |
| `npm test` | Unit tests (Vitest), then build + end-to-end tests against the real Electron app (Playwright) |
| `npm run test:unit` | Unit tests only. Fast, and runs in headless/cloud sessions |

See [TESTING.md](TESTING.md) for how the suite isolates user data, and for the latest test log.

## Verify a clean checkout

```bash
npm ci
npm run typecheck
npm run build
npm test            # needs a desktop session; use npm run test:unit when headless
```

All of these should finish with exit code 0. `npm start` and the end-to-end tests need a desktop session.

## User data

The app stores its data outside the repository, in Electron's `userData` folder:

- Windows: `%APPDATA%\edissistant\`
  - `presets.json`, `projects.json`, `settings.json` (atomic writes, with a `.bak` copy of the previous version)
  - `secrets.bin`: the Claude API key, encrypted with Windows DPAPI via Electron `safeStorage`
  - `transcripts\`: cached transcripts; `models\` and `whisper\`: where you place Whisper models and `whisper-cli.exe`
- The first releases used the misspelled folder `%APPDATA%\edissisant`. On startup the app migrates that folder once, and only if the new folder has no app data yet (see `migrateLegacyUserData` in `src/main/main.ts`).

**Never commit user data, client media, or reference material.** `.gitignore` blocks common media formats, user-data files and secrets. Test media should be generated synthetically (e.g. with FFmpeg `testsrc`).

## Test status

`npm test` runs 36 automated tests (19 unit + 17 end-to-end). All pass on Windows 11 as of 2026-10-28. They cover project and preset management, navigation, video preview, revision workflows (segments, undo/redo, comments, versions), persistence across restarts, backup recovery, data migration and API-key migration. Coverage and gaps are listed in [TESTING.md](TESTING.md). The original manual/harness log is `test_v1.txt`.

## Further reading

- [TESTING.md](TESTING.md): test commands, isolation, test log v2.
- [ARCHITECTURE.md](ARCHITECTURE.md): process model, modules, Windows-specific handling, and areas suited to parallel development.
- [docs/TRANSCRIPTION.md](docs/TRANSCRIPTION.md): local transcription engine: setup, API, caching, GPU policy, test status.
