# Production pipeline, Phase 0: secure local scene renderer

Claude writes bespoke design, animation and caption code (HTML/CSS/SVG/JS). Edissistant runs that code
**locally**, in an isolated renderer, to produce PNG stills and frame-accurate video (ProRes 4444 /
PNG-in-MOV with alpha, H.264).

Phase 0 builds and tests that renderer, using self-contained synthetic scenes and mocked Claude output.

> **Status:**
> - Prototype, tested on Linux only (Electron 45.1 / Chromium 156, software rendering, 4 vCPU container).
> - **No fidelity claim** is made for the editor's professional workflows. That needs their real scenes and
>   exports (see [Reference files](#reference-files-needed-for-the-final-parity-comparison)).
> - Nothing is wired into the editor UI yet. No paid API call was made.

## What it does

```
App (main process)                 Render host (separate Electron process)          Page (untrusted)
──────────────────                 ───────────────────────────────────────          ────────────────
SceneHost client ──stdin──▶ files + open(job) ─▶ session: own random origin,        Claude's scene code
  scrubbed env, own temp folder    network/DNS/proxy dead ends, CSP,           ◀──▶ window.SCENE.render(t)
  watchdog, kills process tree     off-screen sandboxed window, no preload          or renderAt(T) + camAt(T)
                   ◀──stdout── frame RGBA ◀─ DevTools screenshot (PNG) → decode → subframe average
                                            (premultiplied) → post-capture camera (bicubic)
encodeFrames (existing FFmpeg encoder) → ProRes 4444 / PNG-MOV / H.264 → FFprobe validation → cache
```

### Code
- `src/main/scene/host/hostMain.ts`: the render host (trusted code); the lockdown, capture, adapters and watchdogs.
- `src/main/scene/client.ts`: starts the host, the protocol, the watchdog, and process-tree cleanup.
- `src/main/scene/service.ts`: `renderStills`, `renderAnimation`, exact frame times, fingerprint and cache.
- `src/main/scene/shim.ts`: the virtual clock injected before any scene code.
- `src/main/scene/pixels.ts`: premultiplied motion-blur accumulation and the post-capture camera.
- `src/main/scene/png.ts`: the PNG codec (straight alpha, zlib only).
- `src/main/scene/protocol.ts`: job types and stdio framing.
- `src/main/production/ledger.ts`: request fingerprints and regeneration safeguards for paid Claude work.

## Security model (tested, not assumed)

| Layer | What it does |
| --- | --- |
| Separate process | Claude's code runs in a Chromium renderer of a **separate Electron process**. It never sees the app's memory, IPC, settings, API key or project paths. |
| Scrubbed environment | Only display and system variables are passed on. API keys, app variables and `NODE_OPTIONS` are dropped. |
| Own data folder | The host has a fresh temporary profile, deleted when the job ends. |
| Chromium sandbox | `sandbox: true`, context isolation, no Node, no preload, no `<webview>`, no WebGL, no plugins. |
| Off-screen window | No native window exists at all. |
| Only its own files | Job files are served from memory under `edissistant-scene://<random token>/` only. The handler refuses other tokens and `..` paths. |
| Network | Every request except the job's origin, `data:` and `blob:` is cancelled. All DNS resolves to nothing (`host-resolver-rules`). The proxy is a dead end, loopback included. WebRTC is limited to proxied UDP (none). Background networking, component updates, sync and pings are off. |
| CSP | `default-src 'none'`. Scripts and styles from the job only (inline allowed, no `eval`). Images, fonts and media from the job, `data:` or `blob:`. Fetch only to the job's own files. No workers, frames, objects, forms or base. |
| Navigation and APIs | Navigation, redirects, pop-ups, downloads, dialogs and all permissions are denied (camera, microphone, location, clipboard, notifications). |
| Limits | A time limit per load and per frame (the renderer is crashed on overrun). A memory watchdog on the renderer, plus a JS heap cap. The app-side watchdog kills the host if it stops answering. |
| Cleanup | The host leads its own process group. Closing kills the whole tree (`taskkill /T` on Windows) and deletes the temporary folder. |

**Escape suite** (`tests/scene/security.test.ts`, page `tests/fixtures/scenes/escape/`):
- **Setup:** a hostile page runs about 30 attempts. A local HTTP/WebSocket/UDP listener also acts as the host's proxy, so anything that leaves the page is counted.
- **Network:** nothing reached it.
  - Blocked: fetch, XHR, images, CSS `url()`/`@import`/`@font-face`, `<script src>`, WebSocket, EventSource, `sendBeacon`, prefetch/preconnect/dns-prefetch, iframes, form posts, top-level navigation, `meta refresh`, and WebRTC/STUN.
  - Blocked: `file://`, the app's `edissistant-media:` protocol, another job's origin, and `%2e%2e` path tricks.
- **Code and APIs:**
  - `require`, `process`, `module`, `electron`, `ipcRenderer`, `__dirname`, `window.electronAPI` and `chrome.runtime` are all undefined.
  - `eval` and `new Function` are refused, `window.open` returns null, and workers and service workers are refused.
  - Camera, location, clipboard and notifications are denied.
- **The same suite with the CSP switched off** (a test-only switch) still lets nothing out. The host's network filter alone cancels every request, so the layers work independently.
- **Process checks (Linux):**
  - No process in the host tree has the API key or `NODE_OPTIONS` in its environment, even when the parent had them.
  - No process runs with `--no-sandbox`.
  - Every renderer has `Seccomp: 2` (seccomp-BPF active) and `NoNewPrivs: 1`.
- **Background traffic:** the host makes no network connection of its own during a whole job. Without these switches, Electron contacted `redirector.gvt1.com` (Chromium's component updater) in a spike.

**Remaining risk:**
- A bug in Chromium itself (a sandbox escape exploit) is not excluded by tests.
- It is mitigated by keeping Electron current, giving the page no app capability, and the separate process.
- On Windows the Chromium sandbox uses different mechanisms (restricted tokens, job objects, integrity levels). The `/proc` checks above are Linux-only, so Windows needs its own manual check (see the checklist).

## Scene entry adapters (no client style is built in)

| Adapter | Page defines | Used for |
| --- | --- | --- |
| `static` | Nothing; a plain HTML/CSS/SVG design | Design approval stills |
| `scene` | `window.SCENE = { dur, render(t) }`, with t in seconds from the scene start | One file per line (the podcast-style workflow) |
| `registry` | A global list `[{ id, t0, t1 }]`, `render(T)` on an absolute timeline, and optionally `camera(T) → { scale, originX, originY, x, y }` | Many scenes per page (the SaaS-style workflow). Names are configurable per client kit. |

Jobs also carry the per-client settings:
- size, device scale (for example 2 → 4K from a 1080 layout), transparency;
- a query string (the skills' `?alpha=1`, `?nocap=1`, `?matte=1` modes);
- frame rate and motion blur (samples, shutter, heavy windows);
- the post-capture camera;
- a seed.

None of these are defaults for all clients.

**What scene code must do (the contract for Claude):**
- Draw every frame from *t* alone.
- Load fonts with `@font-face` from job files.
- Reference assets by relative path.

**What the renderer guarantees:**
- `Date`, `performance.now`, timers, `requestAnimationFrame`, `requestIdleCallback`, `Math.random`, and CSS and Web Animations all follow the scene clock.
- Timer callbacks run when a frame is drawn, at their due time and in a fixed order.
- The same job gives byte-identical frames, even across processes.

## Rendering maths
- **Frame times:** frame *i* shows time *i·den/num*: 25 = 25/1, 30 = 30/1, 29.97 = 30000/1001. The frame count is `round(duration·fps)`, as in render.py.
- **Motion blur:** subframes at *t + (k/n)·shutter/fps*, averaged in **premultiplied** space and converted back to straight alpha, so semi-transparent edges keep their true colour. Heavy windows get more samples. This is render.py's maths.
- **Post-capture camera:**
  - The page is captured un-zoomed, then scaled about a focal point with a separable Catmull-Rom bicubic, in premultiplied float.
  - Over- and undershoot are clamped once, at 8-bit conversion.
  - A static edge moves in even sub-pixel steps (tested to within 0.05 px per frame), unlike a CSS scale, which re-snaps every frame.
- **Colour:**
  - Capture is sRGB (`--force-color-profile=srgb`, `--disable-lcd-text`).
  - Encoding goes through the existing encoder: BT.709 matrix and tags for YUV formats (ProRes 4444 `yuva444p12le` with 16-bit alpha), and straight `rgba` for PNG-in-MOV.

## Results on Linux (this prototype)

Run with `npm run test:scene` (needs `npm run build:main`, FFmpeg, a display, and a non-root user).

- **Unit tests** (`tests/unit/scene`, `tests/unit/production`): PNG codec, premultiplied accumulation, camera accuracy and symmetry, frame times, fingerprints, protocol framing, and the request ledger.
- **Functional** (`tests/scene/render.test.ts`):
  - static design to PNG, at device scale 1 and 2;
  - deterministic `scene.render(t)`, byte-identical across processes;
  - transparent capture, with motion-blur coverage steps of 1/4…4/4 and true edge colour;
  - the registry adapter at 3840×2160, with canvas particles;
  - post-capture camera steps;
  - exact frame times read back from encoded 25/30/29.97 files;
  - PNG-MOV bit-exact; ProRes 4444 alpha within 1 level and colour within about 1.5 levels;
  - cache reuse.
- **Faults** (`tests/scene/faults.test.ts`):
  - endless loops (in a frame and while loading), a memory bomb and a scene exception each end the job with a clear code;
  - no process, partial file or temporary folder is left behind;
  - the next job works;
  - the virtual clock behaves as specified;
  - cancelling mid-encode stops the host and FFmpeg.
- **Parity harness** (`tests/scene/parity.ts`): a render.py-style Playwright reference (Chromium 153), compared frame by frame using SSIM, PSNR, alpha mean/max and the share of pixels differing by more than 8 levels.
  - **On the synthetic scenes, every compared frame was byte-identical** to Edissistant's (Chromium 156): opaque, transparent, 3 subframes, and 4K at device scale 2 with 4 subframes.
  - A negative control (the same scene 2 frames later) scores PSNR 21–29 dB, so the comparison does detect differences.
  - **This says nothing yet about the editor's real scenes, fonts or Windows text rendering.**
- **Benchmarks** (`tests/scene/bench.test.ts`, written to `test-results/scene/benchmark.json`):

> **Provisional:** measured while other tests shared the CPU; a clean rerun replaces these numbers.

Measured on: Intel(R) Xeon(R) Processor @ 2.10GHz (4 vCPU, 17 GB), linux 6.18.44-fc-v185, software (--disable-gpu), the default for repeatable pixels. Each configuration was rendered twice; both renders were identical.

| Configuration | Frames | Output | ms per frame | Render speed | File |
| --- | ---: | --- | ---: | ---: | ---: |
| 1080p30, 1 sample (no blur), PNG-MOV | 60 | 1920 px wide | 273 | 3.19 fps | 15.8 MB |
| 1080p30 alpha, 3 subframes (render.py default), ProRes 4444 | 60 | 1920 px wide | 545 | 1.71 fps | 14.9 MB |
| 1080p29.97, 3 subframes, PNG-MOV | 60 | 1920 px wide | 954 | 1 fps | 15.9 MB |
| 4K25 (device scale 2), 4 subframes + post-capture camera | pending | | | | |

## Findings during Phase 0
1. **Background traffic:** Electron reaches out to Google's component updater by default. The host switches it, and all other background networking, off; a test proves no connection is made.
2. **Hidden windows:** a hidden Electron window stops painting after a navigation, so DevTools screenshots hang. Off-screen rendering fixes it, and removes the native window altogether.
3. **Helper processes:** Chromium helpers outlive the host process for 1–3 s. The host now leads a process group and the whole tree is killed.
4. **Blocked navigation:** a page that tries to navigate away makes `loadURL` fail with `ERR_ABORTED`. The host stays on its origin and continues, and the attempt is recorded as blocked.
5. **Own-file fetches:** `connect-src 'none'` would also block a scene from fetching its own JSON data, so fetch is allowed for the job's own origin only.
6. **Reference capture size:** in headless Playwright, the raw DevTools screenshot at device scale 2 returns CSS-pixel size (1920×1080). The reference harness uses `page.screenshot({ scale: 'device' })` there, and both sides check every frame's size.
7. **Edge resampling:** clamping the bicubic resample inside each pass biased edge positions by about 0.04 px and made pushes step unevenly. It is now clamped once at the end; error is under 0.005 px.
8. **Timer clock:** a timer's callback now sees the time it was due, not the frame time.

## Request ledger (duplicate-Generate fix)

**The case from Windows testing of PR #7:**
- In a 24-row project, Generate sent 2 requests and Claude answered 11 rows.
- Generate again with nothing changed sent 2 more paid requests for the other 13.

**The new workflow's ledger:**
- Every item (a segment's design, animation, captions…) is fingerprinted by exactly what would be sent.
- Answered items are reused, never re-sent.
- **Asked-but-unanswered items are not re-sent automatically.** They are reported, and only a deliberate regenerate, with a reason, sends them.
- Changed items are sent.
- A double click joins the request in flight.
- Each batch is recorded as soon as it returns, so a failure later doesn't lose what was paid for.

The PR #7 run is replayed in `tests/unit/production/ledger.test.ts`: second Generate → 0 requests. PR #7's own Generate is unchanged on its branch.

## Not done yet / limitations
- **Fidelity with the editor's real work is unmeasured.** That needs the reference files below. Byte-identical results on synthetic scenes and Linux don't carry over automatically to their fonts, effects, Windows text rendering or GPU.
- **Windows:** the render host, the escape suite, process-tree cleanup and the benchmarks have not run on Windows yet.
- **Speed:** CPU only (software rendering), one renderer per job. Capture goes through PNG encode/decode. The post-capture camera runs in JavaScript (about 1–2 s per 4K subframe). Faster paths (a worker pool, off-screen paint buffers, GPU rendering as an option) can come once fidelity is settled.
- **Post-capture camera:** the SaaS kit's exact resampling kernel and camera API are unknown (`render_ms.py` and `core.js` weren't provided). The prototype uses Catmull-Rom; the adapter will be mapped to the real `camSet` once the kit is available.
- **Not implemented:** person mattes, source-frame extraction (`prep`), the white-matte variant, post-grade filters, combined files with audio, and parallel chunks.
- **UI:** no UI yet, and no Claude calls. Scenes are fixtures standing in for Claude output.
- **Stale partial files:** if the app is killed hard mid-render, a `.partial.mov` can remain (as happened here when the test runner killed a timed-out run). A cleanup on start is planned.

## Reference files needed for the final parity comparison

For each, please provide the files **exactly as used for the delivered render**, plus the render settings and, ideally, the same scenes rendered with your own scripts **on the Windows PC Edissistant will run on**.

**Podcast workflow (2–3 lines):**
1. The scene HTML files, and the exact `lib.css`, `lib.js`, `lines.js` and `render.py` that rendered them.
2. Every font file used (for example the Inter Display weights and Playfair Display Italic), and any images or textures.
3. The delivered outputs for those lines:
   - the graded MP4, plus an ungraded MP4 if possible (the grain makes graded frames noisy to compare);
   - the ALPHA MOV;
   - the no-captions alpha MOV, the captions-only alpha MOV and the white matte, if used.
4. The exact command lines (`--fps`, `--sub`, `--shutter`, heavy windows, `--post`, `--alpha`, `--q`), the OS where they were rendered, and the Playwright/Chromium and FFmpeg versions.
5. The one caption render you treat as the quality benchmark, with its scene.

**SaaS workflow:**
1. The Motion Seq Render Kit: `engine/core.js`, `engine/core.css`, `engine/fonts/*`, `render_ms.py`, `RENDER_MS.bat`, `tools/stills.py`.
2. One project folder: `mg.html`, `scenes.js`, `timing.js`, `project.json`, `words.json`, `VO_ALL.wav`, and only the `media/` frames and masks those scenes use.
3. Final 4K/25 renders of two scenes (one with a `camSet` push, one canvas-heavy, such as the storage platter or tile pour), plus the combined file, any alpha pass, and the render settings (`--sub`, `--res`, `--jobs`).

**Both:** confirmation that the files may be used for internal testing.

## Windows checklist (Phase 0)
1. Install and build:
   ```powershell
   npm ci
   ```
   ```powershell
   npx --no install-electron
   ```
   ```powershell
   npm run build:main
   ```
2. With FFmpeg on `PATH`, run `npm run test:scene`.
   - Expected: everything passes except the Linux-only `/proc` assertions, which are skipped on Windows inside the tests.
   - For the parity test, install Playwright's browser first (`npx playwright install chromium`), or set `PARITY_CHROMIUM` to a Chromium executable.
3. Watch Task Manager during the fault tests: no `electron.exe` or `ffmpeg.exe` should remain after each test.
4. With Process Explorer, check the render host's renderer process (`--type=renderer`): integrity level **Untrusted** or **Low**, and a restricted token. It must not run with `--no-sandbox`.
5. Check that `%TEMP%\edissistant-scene-*` folders disappear after the tests.
6. Send `test-results/scene/benchmark.json`, `parity.json` and `security-*.json`.
