# Edissistant

AI-powered production assistant for professional video editors — a Windows desktop app (Electron + React + TypeScript) for planning segments, directing cuts, reviewing with timestamped comments, and keeping each client's style consistent through reusable presets.

> **Status: v0.1.0 development baseline.** This is a safe starting point for development, **not** a production or commercial release. AI planning, transcription, rendering and packaging are not implemented yet. See [Test status](#test-status).

## Requirements

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 22.14.0 (see `.nvmrc`) | Node ≥ 22 expected |
| npm | 11.x | Comes with Node; `package-lock.json` is committed |
| Git | any recent | |
| OS | Windows 10/11 (primary target) | Build and type-check also work on Linux/macOS; the app is only tested on Windows |
| FFmpeg | optional | Not required to build or run. Only used to generate test media |

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

There is **no automated test suite in the repository yet** (no `npm test`). Verification so far has used throwaway Electron harness scripts; see `test_v1.txt` and [Test status](#test-status).

## Verify a clean checkout

```bash
npm ci
npm run typecheck
npm run build
```

All three should finish with exit code 0. `npm start` needs a desktop session, so cloud or headless sessions can only run the first three.

## User data

The app stores its data outside the repository, in Electron's `userData` folder:

- Windows: `%APPDATA%\edissistant\`
  - `presets.json`, `projects.json`, `settings.json` (atomic writes, with a `.bak` copy of the previous version)
  - `secrets.bin`: the Claude API key, encrypted with Windows DPAPI via Electron `safeStorage`
- The first releases used the misspelled folder `%APPDATA%\edissisant`. On startup the app migrates that folder once, and only if the new folder has no app data yet (see `migrateLegacyUserData` in `src/main/main.ts`).

**Never commit user data, client media, or reference material.** `.gitignore` blocks common media formats, user-data files and secrets. Test media should be generated synthetically (e.g. with FFmpeg `testsrc`).

## Test status

Latest results (2026-10-28, Windows 11, Electron 45.1.0):

- Type-check (renderer + main): pass
- Production build: pass
- Clean checkout (`npm ci` + typecheck + build in a fresh copy): pass
- Isolated smoke harness (scratch data folder, not committed): app launch, navigation to Dashboard/Projects/Presets/Settings, project creation via the New Project dialog, video preview and seeking via the media protocol, project and preset persistence across reload and restart: pass

For the full list of features that have **not** been tested, see `test_v1.txt` section 6. Notable gaps: export to CSV/SRT, caption import, rename/duplicate/delete, settings toggles, keyboard-only navigation, packaged installer.

## Further reading

- [ARCHITECTURE.md](ARCHITECTURE.md): process model, modules, Windows-specific handling, and areas suited to parallel development.
