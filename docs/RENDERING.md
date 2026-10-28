# Animation & rendering engine

Cloud Session 2. Turns structured animation instructions into motion graphics and transparent
captions, renders them locally with FFmpeg, re-renders only what changed, and composes a preview
of the whole timeline. No AI API is called. The renderer only consumes JSON specs that a planner (the
future Claude planning engine, or a person) produces.

> **Status: working core, verified on Linux only.** Everything below marked ✅ was run in this cloud
> container: real Chromium drew the frames, real FFmpeg encoded them, and FFmpeg decoded them again
> to check pixels and alpha. Nothing has been run on Windows or macOS, in an NLE, or on a GPU.
> See [What still needs Windows validation](#what-still-needs-windows-validation).

## Pipeline

```
 Planner / editor                Main process (Node)                           Render sandbox (hidden Chromium)
 ────────────────                ───────────────────                           ────────────────────────────────
 AnimationSpec JSON ─IPC─▶ validateAnimationSpec (strict) ──▶ cache lookup ─hit─▶ reuse output
                                     │ miss                                     
                                     ├─ read declared font/image files (bytes only)
                                     ├─ open sandbox ──────────── init(spec, bytes) ──▶ re-validate, load fonts,
                                     │                                                  check installed fonts
                                     │      ◀── RGBA frame i ─── frame(i) request ───▶  renderFrame(ctx, spec, i)
                                     ├─ FFmpeg stdin (rawvideo rgba, exact rate) ─▶ ProRes 4444 / … file
                                     ├─ FFprobe: codec, size, rate, frame count, alpha
                                     └─ atomic move into cache (renders/<sha256>/)
 SequenceSpec ─IPC─▶ for each segment: as above (unchanged → cache) ──▶ FFmpeg overlay composition ──▶ preview.mp4
```

Every render is automatic. Editors never run a command.

## Code layout

| Path | Responsibility |
| --- | --- |
| `src/shared/animation/types.ts` | The spec: `AnimationSpec`, `SequenceSpec`, layers, components, keyframes, export modes |
| `src/shared/animation/validate.ts`, `checker.ts` | Strict validation with dotted paths for every problem |
| `src/shared/animation/timeline.ts` | Exact frame math (NTSC rationals), timecode |
| `src/shared/animation/easing.ts`, `keyframes.ts`, `color.ts`, `random.ts` | Easing (incl. CSS cubic-bezier), keyframe interpolation, color parsing/mixing, seeded PRNG, stable hashing |
| `src/shared/animation/captions.ts` | Frame-accurate caption timing |
| `src/shared/animation/engine/` | Trusted drawing: `render.ts` (layers, transitions, masks, camera), `backgrounds.ts`, `components/*`, `registry.ts` |
| `src/shared/animation/sequence.ts` | Render identity (content hash input), sequence diffing |
| `src/shared/animation/formats.ts` | Export formats and defaults per mode |
| `src/shared/animation/api.ts`, `errors.ts`, `sandboxProtocol.ts` | IPC contracts, coded errors |
| `src/main/render/service.ts` | Render orchestration: queue, cache, progress, cancellation, sequences |
| `src/main/render/encoder.ts`, `probe.ts`, `compose.ts` | FFmpeg encoding, FFprobe validation and alpha verification, preview composition |
| `src/main/render/cache.ts`, `assets.ts`, `gpu.ts`, `tools.ts`, `process.ts` | Content-addressed cache, asset loading, hardware H.264 probing, tool discovery |
| `src/main/render/chromiumFrameSource.ts`, `sandboxPreload.ts` | The sandboxed frame source (security boundary) |
| `src/main/render/ipc.ts`, `index.ts` | IPC channels and wiring (`registerRenderEngine` in `main.ts`) |
| `src/renderer/render-sandbox.html`, `render-sandbox/sandbox.ts` | The sandbox page (second Vite entry; no UI) |
| `src/renderer/lib/render.ts` | Renderer helpers: `renderSegment`, `renderSequence` with progress and cancel |

The frame source is an interface (`FrameSource`), so the Chromium implementation can later be swapped
(e.g. for WebGL/WebGPU or a native renderer) without touching encoding, caching or composition.

## Why this rendering approach

- **Chromium Canvas 2D (Skia), already shipped with Electron.** Full text shaping, system and custom fonts,
  shadows, blur, gradients and compositing. There is no new dependency and nothing to download.
- **Straight RGBA readback.** `getImageData` on a CPU-backed canvas (`willReadFrequently`) returns
  unpremultiplied sRGB pixels. Those go to FFmpeg as `rawvideo rgba`, so alpha is never inferred from color.
- **Frame-indexed, deterministic drawing.** Frame `f` shows time `f / fps`. All randomness is seeded,
  so the same spec gives the same pixels. The determinism test compares two lossless renders byte-for-byte.
- Rejected alternatives: screen capture (no alpha, timing drift); headless browsers via Puppeteer
  (another Chromium download); node-canvas (native module to rebuild per Electron, prebuilt binaries).

## Security: untrusted instructions, trusted code

AI output is treated as untrusted. **Arbitrary generated JavaScript is not executed. That capability is
explicitly deferred** (see [Deferred](#deferred)). The boundary is:

1. **Data, not code.** A spec can only reference registered component types. Every property is
   validated with types, ranges and length limits; unknown properties are rejected. Font families can't
   contain quotes or commas (they are quoted into CSS font strings). Colors are a strict grammar
   (`url(…)` is impossible). SVG paths only allow path commands and numbers. Asset paths must be absolute
   with an allowed extension.
2. **The sandbox re-validates** the spec it receives (defense in depth).
3. **Sandboxed renderer.** `sandbox: true`, `contextIsolation`, no Node integration, its own in-memory
   session. All network and file requests except its own page are cancelled, every permission is denied,
   navigation and new windows are blocked, and a strict CSP applies (`default-src 'none'`). The preload
   exposes only `send` and `onCommand`.
4. **No secrets or paths in the sandbox.** The main process reads declared font and image files and passes
   bytes. The sandbox never sees file paths, settings, the API key or the app's IPC.
5. **Main-side checks.** Messages are routed by sender `webContents` ID, frames are size-checked, and
   exports can only copy files from the render cache to an existing folder with a sanitized name.

The E2E test *"the render sandbox has no Node, no network, no app API"* checks points 3 and 4 inside a
live sandbox: `require`, `process` and `electronAPI` are undefined, and `https://` and `file://` fetches
are blocked.

## The specification

TypeScript types: `src/shared/animation/types.ts`. Examples: `tests/fixtures/animation/*.json`. A segment:

```jsonc
{
  "specVersion": 1,
  "id": "seg-intro",            // stable segment ID
  "start": 12.5,                // timeline seconds (not part of the cache key)
  "duration": 2,                // seconds; optional "end" must equal start + duration
  "width": 1920, "height": 1080, // even, ≤ 4096×2304 pixels
  "fps": 29.97,                 // 1–120 integer or NTSC (23.976, 29.97, 59.94)
  "exportMode": "transparent-motion",   // full-motion | transparent-motion | transparent-captions
  "background": { "type": "transparent" },  // required for transparent modes
  "camera": { "scale": { "keyframes": [{ "t": 0, "value": 1.05 }, { "t": 2, "value": 1 }] } },
  "seed": 7,
  "assets": { "fonts": [{ "family": "Brand Sans", "path": "C:\\Brand\\BrandSans-Bold.otf", "weight": 700 }],
              "images": [{ "id": "logo", "path": "C:\\Brand\\logo.png" }] },
  "layers": [
    { "id": "title", "type": "text", "start": 0.2, "end": 2,
      "transform": { "x": 960, "y": 540, "rotation": 0, "scale": 1 },
      "opacity": 1,
      "enter": { "type": "slide", "direction": "up", "duration": 0.4, "easing": "easeOutCubic" },
      "exit":  { "type": "fade", "duration": 0.3 },
      "mask":  { "type": "wipe", "direction": "right", "progress": 1 },
      "blendMode": "normal",
      "props": { "text": "Hello", "typography": { "fontFamily": "Brand Sans", "fontSize": 96, "fontWeight": 700, "letterSpacing": 2 },
                 "color": "#ffffff", "glow": { "color": "#3a6df0", "blur": 20 },
                 "reveal": { "by": "word", "style": "rise", "stagger": 0.06, "duration": 0.4 } } }
  ]
}
```

- **Animatable values**: any number or color can be a constant or `{ "keyframes": [{ "t", "value", "easing" }] }`
  (`t` in seconds from the layer start). Easing: 18 named curves, `{ "cubicBezier": [x1, y1, x2, y2] }` or `{ "steps": n }`.
- **Layer types (reusable primitives)**: `text` (staggered char/word/line reveals: fade, rise, scale, mask,
  typewriter), `shape` (rect/ellipse/line, draw-on), `path` (SVG path with trim/draw-on: any new shape or
  icon without code), `counter`, `barChart`, `lineChart`, `progress` (bar/ring), `highlight`
  (box/underline/marker/circle), `diagram` (nodes and arrows with staggered reveal), `image`, `captions`, and
  `group` (nested layers with shared transforms, up to three levels).
- **Every layer** can have timing (`start`/`end`), transforms, opacity, enter/exit transitions (fade, slide,
  scale, wipe, blur), masks (wipe, rect) and blend modes. The spec-level `camera` adds pan, zoom and roll.
- **Backgrounds**: transparent, solid, linear/radial gradient, procedural `paper`, `cinematic` (dark
  base, light, vignette, animated seeded grain) and image.
- **Fonts**: generic families always work. Other families must be bundled in `assets.fonts` or installed.
  A missing font fails with `FONT_NOT_FOUND` unless `typography.allowFallback` is true (then you get a warning).
- **Captions** (`captions` layer, required for `transparent-captions`): cues with optional word timing,
  plus font, weight, size, letter spacing, case, color, highlight color, position, alignment, wrap width,
  max lines, stroke, shadow, glow, background box, in-animations (fade, pop, slide-up, typewriter),
  out-animations (fade, slide-down), and karaoke-style word highlighting.

### Timing conventions

- Frame `f` represents the instant `f / fps` (its leading edge). NTSC rates use exact rationals
  (29.97 = 30000/1001). A segment has `round(duration × fps)` frames.
- A caption cue is visible on frames whose time satisfies `start ≤ t < end`. Entrance progress includes the
  frame's own duration, so a cue is visible from its exact first frame. Tests check frames 4/5/24/25 of a
  0.2–1.0 s cue at 25 fps.
- In the preview, segments are placed at `round(start × fps)`, the timeline frame grid.

### Extending (approved extensions)

New visual concepts are added as reviewed code, not generated code:

1. Add a props interface and layer type in `types.ts`.
2. Write a `defineComponent({ type, validate, draw })` in `engine/components/`, using `Checker` for strict props.
3. Register it in `engine/registry.ts` and add tests. Bump `RENDER_ENGINE_VERSION` if existing output changes.

Planners compose these primitives freely. A new look normally needs only a new spec, not new code.

## Export formats and alpha

| Format | Container | Alpha | Verified here (decode check) | Intended use |
| --- | --- | --- | --- | --- |
| `prores-4444` (default for transparent modes) | .mov, `prores_ks` profile 4444, `yuva444p10le`, 16-bit alpha | ✅ | ✅ alpha within ±1/255 of the source; color within ±3 | Premiere Pro, After Effects, Resolve, Final Cut Pro |
| `qtrle` (QuickTime Animation) | .mov, `argb` | ✅ lossless | ✅ bit-exact alpha | Older NLE versions; large files |
| `png-mov` (PNG in QuickTime) | .mov, `rgba` | ✅ lossless | ✅ bit-exact alpha | Lossless; slower decode |
| `vp9-webm` | .webm, `yuva420p` (`alpha_mode=1`) | ✅ lossy | ✅ flat areas keep 0/255; edges are lossy | Web/browser; decoders must use libvpx |
| `prores-422hq` (default full-motion final) | .mov, `yuv422p10le` | ✗ | ✅ metadata | Full-frame graphics |
| `h264-mp4` (default full-motion preview) | .mp4, `yuv420p` | ✗ | ✅ metadata | Previews |

- **"Black is not transparency"** is enforced twice. The validator rejects non-transparent backgrounds in
  transparent modes. `verifyAlpha()` decodes frames and reports `transparencySurvives`, and an opaque black
  ProRes 4444 render is tested to report `false`.
- YUV outputs use the Rec. 709 matrix and are tagged bt709/tv range. RGB formats stay RGB.
- **Alpha is straight (unpremultiplied).** NLE interpretation (straight vs premultiplied) still has to be
  checked in each application. See below.
- Every render is validated before it is cached: codec, width/height, exact frame rate, exact frame count
  (packet count) and alpha pixel format. Failures raise `OUTPUT_INVALID`.

## Caching and selective regeneration

- **Key** = SHA-256 of: engine version + the segment's *visual content* (the spec without `id`, `start`,
  `end`) + format + scale + quality + encoder + SHA-256 of every font and image file. Moving or renaming a
  segment reuses its render, and editing a font file invalidates it.
- **Location**: `%APPDATA%\edissistant\renders\<key>\output.<ext>` + `manifest.json`. Work happens in
  `renders\.tmp\<job>\` on the same volume and is published with a rename. An interrupted render therefore
  never leaves a half-written entry, and stale scratch folders older than one hour are removed at startup.
  Least-recently-used entries are pruned above 50 GB.
- **Sequences**: `renderSequence` validates the whole sequence, renders only segments whose key misses,
  and reports `rendered` vs `reused`. The preview has its own key (segment keys + start times + base video
  identity), so moving a segment recomposes only the preview. `diffSequences()` and `replaceSegment()`
  help the UI show what will change.

## Preview composition

`composePreview` builds one FFmpeg filter graph: a base (the source footage, scaled and padded, with its
audio, or black), then each segment overlaid with `setpts` at its frame-snapped start, enabled only for
its duration. Transparent segments composite with alpha, and full-motion segments cover the base. The
output is H.264 at the segments' render size: half resolution in `quality: 'preview'`, which renders
segments at half size with fast settings. Composition is validated for exact frame count. Tests decode
the boundary frames (9/10, 39/40, 49/50, 74/75) and check that the right content is there.

## Progress, cancellation, errors, cleanup

- Progress events: `queued → validating → loading → rendering (frame n/N) → validating-output → done`, plus
  `cache-hit` and `composing`, with overall progress 0–1, throttled to 0.5 % steps.
- Cancel with `cancelRender(jobId)`, by closing the window, or by quitting. FFmpeg is killed, the sandbox
  window is destroyed, and scratch files are deleted. Queued jobs cancel immediately.
- Error codes: `INVALID_SPEC` (with issue paths), `INVALID_REQUEST`, `FFMPEG_NOT_FOUND`, `FORMAT_NOT_SUPPORTED`,
  `FONT_NOT_FOUND`, `MEDIA_NOT_FOUND`, `SANDBOX_FAILED`, `RENDER_FAILED`, `ENCODE_FAILED` (with FFmpeg's
  stderr tail), `OUTPUT_INVALID`, `COMPOSE_FAILED`, `CANCELLED`.
- Memory: frames stream to FFmpeg with backpressure. At most two frames are in flight (one drawing, one
  encoding), about 8 MB each at 1080p, and textures are built once per render.

## GPU acceleration

Optional, and only for H.264 (previews and `h264-mp4`). On first use, each hardware encoder for the
platform (`h264_nvenc`, `h264_qsv`, `h264_amf` on Windows; `h264_videotoolbox` on macOS) must
complete a real test encode before it is used. Otherwise everything stays on `libx264`. ProRes,
Animation, PNG and VP9 always encode on the CPU. Frame drawing uses a CPU-backed canvas on purpose,
for readback speed and identical output on every GPU. **No GPU path has been tested.** This container
has none; the tests only prove that probing falls back to `libx264`.

## Windows setup

1. Install an FFmpeg build that includes `ffprobe.exe`, `prores_ks`, `qtrle`, `png`, `libvpx-vp9` and `libx264`
   (for example the "full" builds from gyan.dev or BtbN).
2. Either set **Settings → FFmpeg path** to `ffmpeg.exe` or its `bin` folder (`ffprobe.exe` must be next to it),
   put both on `PATH`, or copy them to `%APPDATA%\edissistant\bin\`. `EDISSISTANT_FFMPEG_PATH` also works.
3. Nothing else is required. The engine uses Electron's own Chromium.
4. Check from DevTools in the app: `await window.electronAPI.getRenderStatus()` lists the FFmpeg version,
   available formats, any validated GPU encoder, and problems.
5. Packaging (when added): `dist/renderer/render-sandbox.html` and `dist/main/render/sandboxPreload.js`
   must ship unpacked with the app. FFmpeg is not bundled; a packaging decision is needed (GPL/LGPL build choice).

## How to test on Windows

```bash
npm ci
npm run typecheck
npm run build
npm run test:unit      # FFmpeg-dependent tests are skipped if ffmpeg/ffprobe aren't on PATH
npx playwright test tests/e2e/rendering.spec.ts
```

Then by hand:

1. In the app's DevTools console, render a fixture:
   `await window.electronAPI.renderSegment('t1', <contents of tests/fixtures/animation/transparent-lower-third.json>)`,
   then `exportRender(result.path, 'C:\\Users\\you\\Desktop', 'lower-third')`.
2. Import that `.mov` into Premiere Pro, After Effects, DaVinci Resolve and (on macOS) Final Cut Pro over
   footage. Check that the background is transparent, the edges are clean (no dark or white fringes, i.e.
   straight vs premultiplied interpretation), and that the 85 % translucent bar looks right.
3. Repeat with `captions.json`, and step frame by frame across 0.2 s and 1.0 s to confirm cue timing in the NLE.
4. Try a 29.97 and a 23.976 spec. Check the NLE reads the exact rate and the clip length matches the spec.
5. Use a brand font from `C:\Windows\Fonts` (bundled via `assets.fonts`) and one that's only installed.
6. Render while closing the app, and check Task Manager for leftover `ffmpeg.exe`.

## Test status

Run in this Linux container (Node 22.22, FFmpeg 6.1.1, Electron 45 under `xvfb-run`):

| Area (requirement) | Where | Result |
| --- | --- | --- |
| 1 Spec validation, 10 invalid instructions | `tests/unit/animation/validate.test.ts`, E2E invalid spec | ✅ |
| 2 Timeline/frame math | `timing.test.ts` | ✅ |
| 3 Keyframe interpolation / easing | `timing.test.ts` | ✅ |
| 4 Components | `components.test.ts` (recording canvas) + E2E renders | ✅ |
| 5 Backgrounds | `components.test.ts`, E2E paper/cinematic, determinism | ✅ |
| 6 Alpha preservation (decoded, not screenshots) | `encoder.test.ts` + E2E (ProRes 4444, Animation, PNG, VP9) | ✅ |
| 7 Caption timing | `timing.test.ts`, `components.test.ts`, E2E frame-by-frame alpha | ✅ |
| 8 Output metadata | `encoder.test.ts`, every service render | ✅ |
| 9 Cancellation | unit (running and queued) + E2E (IPC, sandbox closed, no files) | ✅ |
| 11 Missing fonts and media | unit + E2E | ✅ |
| 12 Interrupted rendering | unit (frame failure; crash leftovers cleaned at startup) | ✅ |
| 13 Selective regeneration, 14 cache reuse | unit + E2E sequences | ✅ |
| 15 Temp cleanup | unit + E2E | ✅ |
| 16 Preview composition | unit (exact boundary frames, footage + audio) + E2E | ✅ |
| Sandbox isolation | E2E | ✅ |

Totals: `npm run test:unit` 130/130 (36 existing + 94 new). `npx playwright test` under xvfb: 27/27 (18 existing + 9 new).

## Performance (Linux container, 4 vCPU, software rendering, no GPU)

| Render (4 s, 100 frames, showcase spec) | Wall time | Throughput | Size |
| --- | --- | --- | --- |
| 1920×1080 ProRes 422 HQ (full motion, cinematic background, 8 layers) | 10.2 s | 9.8 fps | 97 MB |
| 1920×1080 ProRes 4444 (same layers, transparent) | 8.2 s | 12.2 fps | 51 MB |
| 960×540 H.264 preview | 1.7 s | 58 fps | 0.1 MB |

A 10 s 1080p graphic takes about 25 s on this machine. Likely costs, in order: copying 8 MB frames
over IPC, `getImageData`, and ProRes encoding (single FFmpeg process). Next steps if needed:
`MessagePort`/shared-memory transfer, rendering in an `OffscreenCanvas` worker, rendering segments in parallel
sandboxes, and keeping one warm sandbox between renders (each render opens a new one: ~0.3–0.5 s).

## What still needs Windows validation

- Everything end to end on Windows 11: sandbox page loading from `file:///C:/…` (URL allow-list), Windows
  FFmpeg builds, paths with spaces and non-ASCII characters, `%APPDATA%` cache, cancellation with no
  orphan `ffmpeg.exe`.
- **NLE compatibility (not verified anywhere)**: ProRes 4444 / Animation / PNG-MOV in Premiere Pro, After
  Effects, DaVinci Resolve and Final Cut Pro, including straight vs premultiplied alpha, Rec. 709 color
  match, and frame rate / length.
- **GPU**: NVENC/QSV/AMF probing and the quality and bitrate of hardware previews.
- Windows font rendering (DirectWrite through Chromium) and the font-availability probe with real brand fonts.
- `npm run dev` (sandbox served by Vite): untested.
- Performance on typical editor hardware, and 4K renders (allowed, untested here).
- macOS: Homebrew FFmpeg discovery, `h264_videotoolbox`, Final Cut Pro.

## Deferred

- **Arbitrary AI-generated JavaScript.** Not executed in this phase. A future design could run it in a
  separate sandbox process with no IPC beyond a frame-in/pixels-out channel, CPU/time limits and no
  network. It would need its own security review. Until then, new looks come from specs, and new
  primitives from reviewed components.
- UI for rendering (buttons, progress, export dialog). The existing UI is unchanged.
- Audio in rendered segments (the preview carries the base video's audio only).
- PNG image-sequence export, HEVC with alpha (macOS VideoToolbox), DNxHR/DNxHD.
- Merging FFmpeg discovery with the transcription module (PR #1) once both are merged.
