# Edissistant architecture

## Process model

```
┌──────────────────────── Electron main process (Node) ────────────────────────┐
│ src/main/main.ts                                                              │
│  • window (frameless, custom title bar)    • JSON persistence (atomic + .bak) │
│  • IPC handlers                            • safeStorage secrets (DPAPI)      │
│  • edissistant-media:// protocol           • dialogs / shell (folder-only)    │
│  • CSP headers                             • legacy userData migration        │
└───────────────────────────────▲───────────────────────────────────────────────┘
                                │ ipcRenderer.invoke / send (contextIsolation on,
                                │ nodeIntegration off)
┌───────────────────────────────┴──────────┐
│ src/main/preload.ts                       │  exposes window.electronAPI
└───────────────────────────────▲──────────┘
┌───────────────────────────────┴───────────────────────────────────────────────┐
│ Renderer: React 19 + react-router (hash router) + Tailwind v4, built by Vite   │
│ src/renderer/                                                                  │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **Build**: Vite builds `src/renderer` into `dist/renderer`, and `tsc -p tsconfig.main.json` compiles `src/main` into `dist/main` (CommonJS/Node16). `package.json` `main` points to `dist/main/main.js`.
- **Dev mode**: only with the explicit `--dev` flag (`npm run dev`), which loads `http://localhost:5173`. Otherwise the app loads the built `dist/renderer/index.html`.
- **Security**: context isolation, no Node in the renderer, a strict CSP in production, and validated arguments on every IPC handler. The renderer can write secrets but never read them back. `shell:openFolder` only opens directories.

### Animation rendering

`src/shared/animation/` holds the animation spec, its validator and the trusted drawing engine (no Node or DOM types, compiled for both processes). `src/main/render/` validates specs, draws frames in a hidden **sandboxed** Chromium window (`render-sandbox.html`, a second Vite entry), encodes them with FFmpeg (ProRes 4444 with alpha by default for transparent output), validates the result with FFprobe, caches it by content hash and composes timeline previews. See [docs/RENDERING.md](docs/RENDERING.md).

## Main-process IPC surface (`window.electronAPI`)

| Area | Channels |
| --- | --- |
| Window | `window:minimize`, `window:maximize`, `window:close`, `window:isMaximized`, event `window:maximized-changed` |
| Data | `presets:load/save`, `projects:load/save`, `settings:load/save` (settings never stores `claudeApiKey`) |
| Secrets | `secrets:status`, `secrets:set`, `secrets:delete` |
| Rendering | `render:status`, `render:segment`, `render:sequence`, `render:cancel`, `render:export`, `render:clearCache`, event `render:progress` (types: `src/shared/animation/api.ts`) |
| Files | `dialog:openFiles`, `dialog:openDirectory`, `file:readText` (.srt/.vtt/.txt, ≤5 MB), `file:saveText` (user-chosen path only), `file:exists`, `shell:openFolder`, `shell:showItem` |
| App | `app:info` |

The type contract lives in `src/renderer/types/index.ts` (`ElectronAPI`). When you add a channel, update `main.ts`, `preload.ts` **and** that interface together.

## Renderer modules

| Path | Responsibility |
| --- | --- |
| `App.tsx` | Route table (hash router; data router so `useBlocker` works) |
| `state/DataProvider.tsx`, `hooks/useStore.ts` | Loads and saves presets/projects/settings over IPC; falls back to `localStorage` in a plain browser |
| `pages/Dashboard`, `Projects`, `Presets`, `Settings` | Top-level screens |
| `pages/PresetEditor.tsx` | Multi-step preset wizard (references, brief, typography, branding) |
| `pages/ProjectEditor.tsx` | Project shell: header, tabs, undo/redo, save, keyboard shortcuts |
| `pages/project/Workspace.tsx`, `Inspector.tsx`, `useProjectMedia.tsx` | Video viewer + segment sequence editing |
| `pages/project/Review.tsx` | Timestamped comments, versions |
| `pages/project/Export.tsx` | CSV/SRT export, render settings (rendering not implemented) |
| `components/` | App chrome (TitleBar, Sidebar, Layout) and feature components |
| `components/ui/` | Design-system primitives (Button, Card, Field, Modal, Popover, Toast…) |
| `lib/` | Pure helpers: `captions.ts` (SRT/VTT parse), `time.ts` (timecode), `project.ts` (segments, media URLs), `catalog.tsx` (built-in presets) |
| `styles/globals.css` | Tailwind v4 theme tokens |

## Windows-specific handling

- **Frameless window** with a custom title bar (`TitleBar.tsx`); minimize/maximize/close go over IPC.
- **Secrets** use Electron `safeStorage` (async API), which on Windows uses DPAPI tied to the user account. `secrets.bin` can't be moved to another machine or user. If encryption is unavailable, saving a key fails rather than falling back to plaintext.
- **Local media** is streamed through the privileged `edissistant-media://local/<encoded path>` scheme, with HTTP range support for seeking. Backslashes become forward slashes in `mediaUrl()`. Only allowlisted extensions are served.
- **userData**: `%APPDATA%\edissistant`, with a one-time migration from the misspelled `%APPDATA%\edissisant`.
- **Hardware acceleration** can be disabled in settings. It is read before `app.ready`, so the change takes effect after a restart.
- **No packaging yet**: there's no electron-builder/forge config, installer, code signing or auto-update.

## Areas suited to isolated parallel development

These areas have low overlap with each other, so separate branches are unlikely to conflict:

1. **More end-to-end coverage** (`tests/e2e`): extend toward the gaps listed in TESTING.md. *New spec files only.*
2. **More unit tests** (`tests/unit`). *New files only.*
3. **Packaging**: electron-builder/forge config, app icon, NSIS installer. *Touches `package.json` and new config files.*
4. **Export**: CSV/SRT output correctness in `pages/project/Export.tsx`.
5. **Review features**: comments and versions in `pages/project/Review.tsx`.
6. **Settings**: `pages/Settings.tsx`.
7. **AI planning integration** (future): a new main-process module plus IPC channels. Coordinate changes to `main.ts`, `preload.ts` and `types/index.ts`.

**Shared hot spots** (coordinate before parallel edits): `src/main/main.ts`, `src/main/preload.ts`, `src/renderer/types/index.ts`, `state/DataProvider.tsx`, `components/ui/*`, `styles/globals.css`, `package.json`/`package-lock.json`.
