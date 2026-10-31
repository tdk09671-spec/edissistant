# Animation & rendering engine

Cloud Session 2. Turns structured animation instructions into motion graphics and transparent
captions, renders them locally with FFmpeg, re-renders only what changed, and composes a preview
of the whole timeline. No AI API is called. The renderer only consumes JSON specs that a planner (the
future Claude planning engine, or a person) produces.

> **Status: verified on Linux and Windows 11, and in Premiere Pro, After Effects and DaVinci Resolve.**
> Real Chromium drew the frames, real FFmpeg encoded them, and FFmpeg decoded them again to check
> pixels and alpha ([Windows 11](#windows-11-2026-10-29)). The outputs were then imported into the three
> editing applications by hand ([Editing applications](#editing-applications-manual)). macOS and Final Cut
> Pro are untested. See [Known limitations](#known-limitations) and [Still untested](#still-untested).

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
  A keyframe's `easing` shapes the motion **from that keyframe to the next** (as in CSS and Lottie), so the last
  keyframe's easing is unused. Without one, the span uses `easeInOutCubic`; set `"easing": "linear"` on the
  earlier keyframe for constant speed.
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
  (29.97 = 30000/1001).
- A segment covers timeline frames `round(start × fps)` through `round((start + duration) × fps) − 1`
  (`segmentFrames` in `src/shared/animation/timeline.ts`). The start and the end are snapped to the same
  grid and the frame count is their difference; the duration is never rounded on its own. That
  keeps back-to-back segments free of overlaps and gaps and puts every out-point on its exact frame. The
  rendered clip, the preview composition and the render cache key all use this span, so moving a
  segment re-renders it only when the move changes its frame count (render engine version 2).
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
- YUV outputs use the Rec. 709 matrix, limited (tv) range, and carry bt709 primaries, transfer and matrix
  tags. The range *flag* is only written to H.264 (.mp4) and VP9 (.webm): QuickTime's `colr` atom (`nclc`)
  in the ProRes .mov files has no range field, so FFprobe reports `color_range=unknown` for them. ProRes is
  limited range by convention, and Premiere Pro, After Effects and Resolve all read it that way. RGB formats
  (Animation, PNG-MOV) stay RGB and carry no color tags.
- **Alpha is straight (unpremultiplied).** Premiere Pro, After Effects and Resolve interpret it as straight
  (see [Editing applications](#editing-applications-manual)).
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
for readback speed and identical output on every GPU. A hardware encoder can pass the probe and still
fail on a real render (NVENC H.264 is limited to 4096 px wide; other apps can hold its sessions), so a failed
hardware encode is retried once on `libx264` and the result carries a warning.

Tested on Windows with an RTX 3070 (driver 617.42): `h264_nvenc` is validated and used; `h264_qsv` and
`h264_amf` fail their probes and are skipped. A 1080p NVENC render measured 43.3 dB PSNR / 0.96 SSIM against
a ProRes reference (24 Mbps). There is no setting to turn GPU encoding off yet (the app's hardware
acceleration setting does not affect it).

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

### Windows 11 (2026-10-29)

Windows 11 Pro 10.0.26300, Ryzen 7 3800XT (8C/16T), 32 GB, RTX 3070, Node 22.14, Electron 45, FFmpeg
N-120858 (2025-08-31, 8.0-dev). `npm run typecheck`, `npm run build` ✅; `npm run test:unit` 137/137;
`npx playwright test` 27/27. Beyond the suites, the built app was driven through `window.electronAPI` with an
isolated appData folder and every output decoded again with FFmpeg:

| Area | Result |
| --- | --- |
| All six formats: frame count, size, rate, pixel format | ✅ |
| Alpha (ProRes 4444, Animation, PNG-MOV, VP9): empty areas alpha 0; 50 % white decodes as RGB 255 / alpha 128 (straight, unpremultiplied); no dark fringe on anti-aliased edges | ✅ |
| Colour: #c87828 exact (alpha formats) / within 3 code values (422 HQ, H.264); 75 % bars within 2 | ✅ |
| Rec. 709 tags (`color_space`, `color_primaries`, `color_transfer`) in every YUV output and the preview | ✅ after fix |
| Keyframes: linear, easeInOutCubic, cubic-bezier, opacity, scale match the maths on every frame (≤ 0.01 px) | ✅ |
| Caption cues and timeline placement on the exact frame at 25, 30, 23.976 and 29.97 fps | ✅ |
| Backgrounds (solid, linear/radial gradient, paper, cinematic, image) deterministic; all components, masks, transitions, groups | ✅ |
| 60 s preview over footage: 1500 frames, source audio kept (0 ms lag, correlation 0.9999), graphics from frame 126 | ✅ |
| Unicode and space paths: appData, cache, configured FFmpeg folder, assets, export folder and names | ✅ |
| Cancel / quit mid-render: `ffmpeg.exe` gone in 0.25 s / 0.42 s, no files left, clean relaunch | ✅ |
| Invalid specs (14 kinds incl. injection attempts), missing fonts/media/base video | ✅ |
| `npm run dev`: sandbox served by Vite renders byte-identical frames to the production build | ✅ |
| Integration with PR #1 (local merge): 245 unit tests, E2E 32 + 1 skipped; transcription and rendering run concurrently and quit cleanly | ✅ |

Fixed during Windows validation: missing Rec. 709 tags with FFmpeg 7+; a test that assumed no GPU; NVENC
failures (e.g. > 4096 px) now fall back to `libx264`; an FFmpeg exit while frames were queued surfaced as a raw
`EPIPE`/`EOF` instead of `ENCODE_FAILED`; preview composition memory (one decoder thread per clip:
24 × 1080p segments 10.8 → 4.5 GB); `mask.feather` was typed but not supported; keyframe easing semantics
documented and the fixtures corrected. Pre-merge: the sandbox-probe E2E test rendered only 6 s, so the
render could finish before the cancel arrived (intermittent `ok: true`). It now uses 60 s and passed 20/20
repeated runs.

### Editing applications (manual)

Checked by hand on Windows 11, recorded 2026-10-30, with a synthetic test package rendered by this engine
(no client media): frame-numbered slates in ProRes 4444, ProRes 422 HQ, Animation and PNG-MOV at 25, 29.97
and 23.976 fps; a lower third and captions in the three alpha formats; a full-frame graphic; and a
synthetic H.264 background plate.

| Application | Checks passed |
| --- | --- |
| Adobe Premiere Pro | 18 / 18 |
| Adobe After Effects | 5 / 5 |
| DaVinci Resolve | 5 / 5 |

Passed areas: transparency (straight alpha, plate visible through transparent areas), graphic edges (no
dark or bright halos), visual color match, frame-rate detection, animation timing, and the tested
playback behavior. In Premiere Pro, the audio waveform of the 60 s preview was also checked against the
source footage's audio and stayed aligned. That shows the preview keeps the source audio unshifted. It is
not a lip-sync test: the synthetic source is a continuous tone with no sync markers.

Application version numbers were not recorded. Not covered: Final Cut Pro (macOS), VP9 WebM in editing
applications (a browser format), and audio alignment in After Effects and Resolve.

## Performance (Windows 11, Ryzen 7 3800XT, RTX 3070)

Measured with ~40–50 % unrelated background CPU load on the machine, so these are conservative.
CPU = whole-system average; cores = average cores used.

| Render | Time | fps | Size | CPU | Electron / FFmpeg cores | Peak RAM | GPU / NVENC |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1080p25 10 s ProRes 422 HQ (showcase) | 15.5 s | 16.1 | 243 MB | 84 % | 1.1 / 5.1 | 0.6 GB | 23 % / – |
| 1080p30 10 s ProRes 422 HQ | 17.7 s | 17.0 | 292 MB | 78 % | 1.1 / 5.5 | 0.5 GB | 26 % / – |
| 1080p25 10 s H.264 (NVENC) | 14.2 s | 17.6 | 28 MB | 50 % | 1.1 / 0.2 | 0.7 GB | 16 % / 17 % |
| 1080p25 4 s transparent ProRes 4444 | 4.6 s | 21.6 | 16 MB | 72 % | 0.5 / 6.4 | 1.4 GB | 16 % / – |
| 1080p25 4 s transparent Animation / PNG-MOV | 2.3 / 2.1 s | 43 / 47 | 2.4 / 3.4 MB | 57–60 % | ~0.9 / ≤ 0.3 | 0.4 GB | – |
| 2160p25 4 s ProRes 422 HQ | 23.6 s | 4.2 | 387 MB | 75 % | 1.1 / 5.1 | 1.1 GB | 11 % / – |
| 2160p25 4 s transparent ProRes 4444 | 18.1 s | 5.5 | 63 MB | 91 % | 0.8 / 9.8 | 4.9 GB | 8 % / – |
| 2160p25 4 s H.264 (NVENC) | 22.2 s | 4.5 | 11 MB | 52 % | 1.1 / 0.2 | 1.5 GB | 17 % / 25 % |
| 60 s preview over 1080p footage, 6 graphics, 960×540 | 11.4 s | 132 | 44 MB | 80 % | 0.4 / 2.5 | 1.3 GB | NVENC 29 % |
| 60 s preview, 1920×1080 | 36.8 s | 41 | 48 MB | 91 % | 0.6 / 7.1 | 3.6 GB* | NVENC 63 % |

\* Before the composition fix. Frame drawing and transfer, not encoding, limit full-motion renders: NVENC is no
faster than ProRes at 1080p. Preview composition memory still grows by ~165 MB per 1080p segment (48 segments
≈ 8 GB); very long timelines should be composed in batches.

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

**Fixed after the Windows run: preview placement at NTSC rates.** The preview composer wrote each segment's start
and end as seconds with 6 decimals. Where that rounded up past the frame's exact time (e.g. 1.064 s at
24000/1001 snaps to frame 26 = 1.0844166…s), the segment appeared one frame late and lost its last frame. Start
times whose 6-decimal form rounds down were unaffected, which is why the Windows check above passed. Clips are
now stamped by frame number in the sequence's exact frame time base (`settb=1001/30000,setpts=N+first`).
`tests/unit/render/compose.test.ts` checks every frame with real FFmpeg at 24000/1001 and 30000/1001. Segment
renders, alpha and audio are unchanged.

## Known limitations

- **Preview composition memory grows with the number of segments**: about 165 MB per 1080p segment
  (48 segments ≈ 8 GB), even after the decoder-thread fix. Compose very long timelines in batches.
- **GPU encoding can't be turned off.** A validated hardware H.264 encoder (e.g. NVENC) is always used for
  previews and `h264-mp4`. The app's hardware-acceleration setting doesn't affect it. A failed hardware
  encode still falls back to `libx264` automatically.
- **Fractional frame rates: layer start/end edge case.** Layer `start`/`end` times are compared without
  tolerance, so a time computed as `frame / 29.97` (a few µs late) starts the layer one frame later than
  `frame × 1001 / 30000`. Planners and specs should snap times to the frame grid.

## Still untested

- Final Cut Pro and macOS: Homebrew FFmpeg discovery, `h264_videotoolbox`.
- Intel QSV and AMD AMF on real hardware; real brand fonts beyond the Windows system fonts.
- Packaged builds.

## Deferred

- **Arbitrary AI-generated JavaScript.** Not executed in this phase. A future design could run it in a
  separate sandbox process with no IPC beyond a frame-in/pixels-out channel, CPU/time limits and no
  network. It would need its own security review. Until then, new looks come from specs, and new
  primitives from reviewed components.
- UI for rendering (buttons, progress, export dialog). The existing UI is unchanged.
- Audio in rendered segments (the preview carries the base video's audio only).
- PNG image-sequence export, HEVC with alpha (macOS VideoToolbox), DNxHR/DNxHD.
- Merging FFmpeg discovery with the transcription module (PR #1) once both are merged.
