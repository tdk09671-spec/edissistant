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
SceneHost client ══socket══▶ files + open(job) ─▶ session: own random origin,      Claude's scene code
  scrubbed env, own temp folder    network/DNS/proxy dead ends, CSP,           ◀──▶ window.SCENE.render(t)
  watchdog, owns host by PID+start off-screen sandboxed window, no preload          or renderAt(T) + camAt(T)
                  ◀══socket══ frame RGBA ◀─ DevTools screenshot (PNG) → decode → subframe average
                                            (premultiplied) → post-capture camera (bicubic)
encodeFrames (existing FFmpeg encoder) → ProRes 4444 / PNG-MOV / H.264 → FFprobe validation → cache
```

`══socket══` is a private, authenticated channel for one job: a named pipe on Windows, a Unix socket elsewhere.
The host's stdin is closed, and its stdout/stderr carry diagnostics only (see [Render host IPC](#render-host-ipc-windows-blockers-b1-and-b2)).

### Code
- `src/main/scene/host/hostMain.ts`: the render host (trusted code); the lockdown, capture, adapters and watchdogs.
- `src/main/scene/client.ts`: starts the host, owns its processes, the watchdog, verified cleanup and the cleanup report.
- `src/main/scene/ipc.ts`: the per-job endpoint, connection file, mutual proof and framed channel.
- `src/main/scene/processes.ts`: process identity (PID + OS start time), the owned tree and verified kills.
- `src/main/scene/recovery.ts`: owner markers, the partial-output registry and crash recovery.
- `src/main/scene/service.ts`: `renderStills`, `renderAnimation`, exact frame times, fingerprint and cache.
- `src/main/scene/shim.ts`: the virtual clock injected before any scene code.
- `src/main/scene/pixels.ts`: premultiplied motion-blur accumulation and the post-capture camera.
- `src/main/scene/png.ts`: the PNG codec (straight alpha, zlib only).
- `src/main/scene/protocol.ts`: job types and message framing (size-capped header + binary payload).
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
| Network | Every request except the job's origin, `data:` and `blob:` is cancelled. All DNS resolves to nothing (`host-resolver-rules`). The proxy is a dead end, loopback included. Background networking, component updates, sync and pings are off. |
| WebRTC | The RTC constructors (`RTCPeerConnection`, `webkitRTCPeerConnection`, `RTCDataChannel` and the rest) are removed before any page script runs, in every frame including `about:blank` ones. Underneath, WebRTC is limited to proxied UDP (none), and the mDNS local-address feature is off. |
| WebGPU and device APIs | WebGPU is disabled in Chromium (`WebGPUService`, the `WebGPU` Blink feature), and `navigator.gpu` is undefined in every frame, in GPU mode too. WebUSB, Web Bluetooth, WebHID, Serial, WebXR, WebNFC and Direct Sockets are disabled as Blink features. |
| Printing | `window.print()` is replaced by a no-op before page scripts run, in every frame. It returns at once, so it can't stall a frame or wait for a timeout. |
| CSP | `default-src 'none'`. Scripts and styles from the job only (inline allowed, no `eval`). Images, fonts and media from the job, `data:` or `blob:`. Fetch only to the job's own files. No workers, frames, objects, forms or base. A CSP `sandbox` (scripts and same-origin only: no pop-ups, forms, top navigation, modals or downloads). A `Permissions-Policy` header turns off camera, microphone, location, display capture and other powerful features. **CSP is one layer, not the barrier**: every test below also runs with it switched off. |
| Navigation and APIs | Navigation, redirects, pop-ups, downloads, dialogs and all permissions are denied (camera, microphone, location, clipboard, notifications). Permission requests and checks are recorded. External protocols (`mailto:`, `tel:`, `ms-settings:`, custom schemes) are cancelled by the network filter before the OS sees them. |
| App ↔ host channel | A per-job named pipe or Unix socket with a random name, a one-time connection file, a mutual HMAC proof and a single connection. Every message carries the job id and is size-capped. See [Render host IPC](#render-host-ipc-windows-blockers-b1-and-b2). |
| Limits | A time limit per load and per frame (the renderer is crashed on overrun). A memory watchdog on the renderer, plus a JS heap cap. The app-side watchdog kills the host if it stops answering. |
| Cleanup | The app owns the host by PID **and** OS start time, plus the helpers that started after it. It asks the host to quit, kills the host only through its own process handle, and kills a leftover helper only after re-checking its identity. No `taskkill /T`, no process-group kill, no kill by PID alone. See [Process ownership](#process-ownership-and-cleanup). |
| Crash recovery | Job folders carry an owner marker and partial outputs are registered, so files left by a hard kill can be removed later without touching anything else. See [Crash recovery](#crash-recovery). |

**Escape suite** (`tests/scene/security.test.ts`, page `tests/fixtures/scenes/escape/`):
- **Setup:** a hostile page runs about 30 attempts. A local HTTP/WebSocket/UDP listener also acts as the host's proxy, so anything that leaves the page is counted.
- **Network:** nothing reached it.
  - Blocked: fetch, XHR, images, CSS `url()`/`@import`/`@font-face`, `<script src>`, WebSocket, EventSource, `sendBeacon`, prefetch/preconnect/dns-prefetch, iframes, form posts, top-level navigation, `meta refresh`, and WebRTC/STUN.
  - Blocked: `file://`, the app's `edissistant-media:` protocol, another job's origin, and `%2e%2e` path tricks.
- **Code and APIs:**
  - `require`, `process`, `module`, `electron`, `ipcRenderer`, `__dirname`, `window.electronAPI` and `chrome.runtime` are all undefined.
  - `eval` and `new Function` are refused, `window.open` returns null, and workers and service workers are refused.
  - Camera, location, clipboard and notifications are denied.
- **Renderer hardening (added after the Windows report):**
  - **Camera and microphone:** the host runs this test with Chromium's fake camera and microphone (`use-fake-device-for-media-stream`), so a device always exists. `getUserMedia` (video + audio) fails with `NotAllowedError`, and the permission handler records the denied `media` request. Before, Linux had no device, so a `NotFoundError` couldn't prove the denial. `getDisplayMedia` is blocked too. The fake-device switch is test-only and the fake permission-UI switch is never used.
  - **Printing:** `window.print()` returns at once in the page and in an `about:blank` frame, and the frame that calls it finishes in under 5 s (it takes milliseconds; the old stall waited for the frame timeout).
  - **WebRTC:** `new RTCPeerConnection()` throws `TypeError` in the page; the constructor is undefined in an `about:blank` frame too.
  - **WebGPU:** `navigator.gpu` is undefined in the page and in an `about:blank` frame, in software mode and **in GPU mode** (a separate test, with `--scene-gpu`). Requesting an adapter fails.
  - **External protocols:** a `mailto:` link, a custom-scheme anchor, `window.open('ms-settings:')` and a `tel:` iframe launch nothing. Checked two ways on Linux: every process in the host tree runs the Electron executable (`/proc/<pid>/exe`), and fake `xdg-open`/`xdg-email`/`gio`/browser handlers placed first on the host's `PATH` were never run.
  - **UDP (scoped evidence):** after the hostile page ran, there are no UDP sockets owned by this user in this network namespace (`/proc/net/udp`, plus `udp6` where it exists), other than the test listener's. A positive control shows the listener's own socket is seen. Chromium's helpers are non-dumpable, so their per-process socket tables can't be read; this check is user- and namespace-wide, which covers the network service where WebRTC and mDNS sockets would live. **It is Linux-only evidence, not a claim of complete network isolation on every platform.**
- **The same suite with the CSP switched off** (a test-only switch) still lets nothing out, printing still returns, WebRTC is still blocked and `navigator.gpu` is still undefined. The host's network filter alone cancels every request, so the layers work independently.
- **Process checks (Linux):**
  - No process in the host tree has the API key or `NODE_OPTIONS` in its environment, even when the parent had them.
  - No process runs with `--no-sandbox`.
  - Every renderer has `Seccomp: 2` (seccomp-BPF active) and `NoNewPrivs: 1`.
- **Background traffic:** the host makes no network connection of its own during a whole job. Without these switches, Electron contacted `redirector.gvt1.com` (Chromium's component updater) in a spike.

**Remaining risk:**
- A bug in Chromium itself (a sandbox escape exploit) is not excluded by tests.
- It is mitigated by keeping Electron current, giving the page no app capability, and the separate process.
- On Windows the Chromium sandbox uses different mechanisms (restricted tokens, job objects, integrity levels). The `/proc` checks above are Linux-only, so Windows needs its own manual check (see the checklist).
- **Network evidence is scoped.** On Linux: no request reached the listener or proxy, and no UDP socket owned by the user in the test's network namespace. On Windows the listener checks are portable, but the UDP-socket and process-executable checks are not; they need `Get-NetUDPEndpoint` and Process Explorer (checklist). This is not a claim of complete network isolation under every OS configuration.
- **The WebRTC removal is a page-level layer.** It is backed by the proxy-only UDP policy, the disabled mDNS feature, dead DNS and the request filter, but it is not a Chromium build flag. A renderer exploit could reach the network stack the same way any Chromium bug could.
- **The Windows named pipe** uses libuv's default security descriptor. Other local users may be able to open it, but they cannot pass the mutual proof, and only the first authenticated connection is accepted. Restricting the pipe's ACL to the current user would need native code; it is not done.
- **Windows start-time comparison:** the process list (CIM `CreationDate`) and the kill check (`Process.StartTime`) are both converted to UTC milliseconds. A local-time ambiguity, such as the repeated hour when daylight saving ends, could make them disagree. The error is on the safe side: the process is reported as `skipped: reused` and not killed.
- **Helpers spawned between snapshots:** if the host crashes, a helper started after the last snapshot is not in the owned list. Chromium helpers exit when the browser process goes away, so this is expected to be harmless, but it is untested on Windows.

## Render host IPC (Windows blockers B1 and B2)

**The problem (Windows validation of 18823a1):**
- **B1:** Electron 45 on Windows closes the child's `stdin` before the host can read its job.
- **B2:** Electron writes stray CRLF bytes to `stdout` before the first message, which broke the stdout framing.
- With stdio as the transport, all 24 scene tests failed on Windows unless an untracked harness workaround was used.

**The fix: stdio is no longer the transport.**
- The host is started with `stdin` set to `ignore`.
- `stdout` and `stderr` are collected into a rolling 8 KB diagnostics buffer (`SceneHost.log`) and are never parsed.
- All protocol traffic goes over a dedicated per-job channel built on Node's `net` module only (no new dependency).

**Exact architecture (`src/main/scene/ipc.ts`):**
1. **Endpoint, created by the app before the host starts:**
   - Windows: a named pipe `\\.\pipe\edissistant-scene-<32 random hex>`. libuv creates it with `FILE_FLAG_FIRST_PIPE_INSTANCE`, so no other process can own that name first.
   - macOS/Linux: `ipc.sock` inside the job's private temp folder (`mkdtemp`, mode 0700).
2. **Connection file:** `<job folder>/ipc.json`, holding `{endpoint, secret (256-bit), jobId (64-bit)}`.
   - It is written owner-only (0600) with `wx`, so it never overwrites an existing file.
   - The host reads it and deletes it at startup.
   - No secret goes in argv or the environment. The only argument is the job folder.
3. **Mutual proof before any job data:**
   - The host connects and sends `hello {jobId, nonce, proof = HMAC-SHA256(secret, "edissistant-scene|host|<jobId>|<nonce>")}`.
   - The app checks the proof in constant time (`timingSafeEqual`), then answers `welcome {proof = HMAC(secret, "…|app|…")}`.
   - The host checks that answer too, so a fake endpoint gets no job data either.
   - A client is dropped, without a single byte sent to it, if it sends a bad proof, a malformed hello, more than 4 KB, data after its hello, or nothing within 5 s.
4. **One connection only:**
   - After the first authenticated host, the app closes its listener.
   - On POSIX the socket file is deleted with the job folder.
   - A later client, even one holding the secret, cannot connect.
5. **Framing:**
   - Each message is a magic number, a length-prefixed JSON header (which declares the binary length), then the binary payload.
   - Every header carries the `jobId`. A wrong job id is a fatal protocol error.
   - Caps: header 1 MB. The payload is limited to one 8192² RGBA frame (256 MB) on the app side, and to 512 MB per file on the host side, with 1 GB per job.
   - Oversized, negative or corrupt framing is fatal. The channel is closed and the job fails with `HOST_FAILED`; nothing is skipped or resynchronised.
6. **Backpressure:** every send waits for `drain`. Sockets are paused until the channel reader is attached, so no bytes are lost between the handshake and the first message.
7. **Lifecycle:**
   - **Start:** the app listens (time limit: load limit + 10 s), then spawns the host and races the accept against the host's exit.
   - **Ready:** the host sends `ready` with its versions, then each command (`open`, `capture`, `probe`, `close`) gets an `id`-matched answer or an `error`.
   - **Cancel:** the `AbortSignal` calls `close()` with `CANCELLED`.
   - **Errors:** host errors arrive as `error {code, message}`. A crash or exit of the host, or a closed connection, fails every pending request at once with `HOST_FAILED`.
   - **Shutdown:** the app sends `close` and the host quits. **If the app dies, the host sees the connection close and exits on its own** (tested by the crash test).

**Tests:**
- `tests/unit/scene/ipc.test.ts` (9 tests), without Electron. It covers:
  - the connection file;
  - endpoint formats;
  - mutual proof and job ids;
  - a forged proof and an HTTP request are refused and receive nothing;
  - single connection;
  - an impostor app endpoint is refused;
  - pipelined data after the hello;
  - another job's message, an oversized payload and stray CRLF bytes are each fatal;
  - a 64 MB frame streamed intact under backpressure.
- `tests/scene/ownership.test.ts`, on the real host:
  - **B2 regression:** a test switch makes the shipped host write junk to stdout and stderr before and after connecting. The job renders correctly and the junk shows up only in the diagnostics.
  - A raw connection to a running job's endpoint is refused, and the job is unaffected.
- **B1** is covered structurally: the host never reads stdin (`stdio: ['ignore', …]`). Every scene test now runs through the socket.

## Process ownership and cleanup

**The problem (Windows):**
- Cleanup ran `taskkill /T` on the host's PID after the host had already exited.
- Windows had reused that PID, so the kill hit an unrelated process tree.

**The fix (`src/main/scene/processes.ts`, `client.ts`):**
- **Identity = PID + OS start time.** A PID alone is never trusted.
  - Linux: `/proc/<pid>/stat` field 22.
  - Windows: `Win32_Process.CreationDate` (CIM, through PowerShell), as a FILETIME in ms.
  - Elsewhere: `ps -o lstart`.
- **Owned tree:**
  - The host is identified while it is still the app's unreaped child, so its PID can't have been reused yet.
  - Helpers are its descendants by parent PID, **and only if each started no earlier than its parent**. This drops stale parent links left by reused PIDs.
  - The tree is recorded after `ready`, again after each `open` (the scene's renderer exists then), and again at `close` while the host is alive.
- **Stopping, in order:**
  1. Send `close` and let the host quit.
  2. After 2 s, if it is still alive, kill it **through its own `ChildProcess` handle**, never by PID. Node holds that handle until the process is reaped, so this kill cannot reach another process.
  3. Give helpers up to 3 s to exit with the host.
  4. Kill any helper still running only through `killVerified`. That function re-reads the identity and kills only if both the PID and the start time match. On Windows the check and the kill use **the same `System.Diagnostics.Process` handle**, so there is no gap in which the PID could be reused.
  5. Delete the job folder, retrying while Windows releases handles.
- **Never used:** `taskkill /T`, process-group kills, `detached`, or a kill by PID alone.
- **Report:** `SceneHost.cleanup` = `{owned (pid, start, name, role), exited, killed, skipped}`. A helper whose PID now has another start time is reported as `skipped: reused` and left alone.
  - On Linux, a normal job owned 8 processes (the host plus 7 Chromium helpers). All 8 exited on their own; none had to be killed and none was skipped (`test-results/scene/ownership.json`).

**Regression tests:**
- `tests/scene/ownership.test.ts`:
  - The user's own jobs keep running through a normal completion, a cancellation, a frame timeout and a renderer crash. Those jobs are a Node loop, a real FFmpeg encode and a Python loop when Python is present, checked by PID + start time.
  - Every owned process is gone after each job end.
  - PID reuse is tested through the real kill path on every platform: a stale record (same PID, older start time) pointing at a live user process kills nothing and reports `reused`.
- `tests/unit/scene/processes.test.ts`:
  - stale parent links;
  - exited / reused / alive classification;
  - a real `sleep` process survives a stale record and is stopped only with its true identity.
- `tests/scene/faults.test.ts`: every fault test now checks the cleanup report against live process identities.

## Crash recovery

**The problem:** if the app is killed hard mid-render, its temp folder and the `.partial.mov` remain.

**Now:**
- **Job folders:**
  - Each `edissistant-scene-*` temp folder gets an `owner.json` naming the app process by PID + start time.
- **Partial outputs:**
  - They are named `<output>.edissistant-partial-<random token>.<ext>`.
  - Each one is registered in `<state dir>/partials/<token>.json` with its owner. The default state dir is `%TEMP%\edissistant-scene-state` (Windows) or `$TMPDIR/edissistant-scene-state` (elsewhere).
  - The entry is removed when the render finishes or fails normally.
- **`recoverAbandonedRenderArtifacts({stateDir})`** removes only:
  - temp folders that have the `edissistant-scene-` prefix **and** an Edissistant owner marker whose owner is gone (exited, or its PID now has another start time);
  - partial files that are registered, whose owner is gone, and whose name has the exact `.edissistant-partial-<token>.` form from the registry.
- **Never touched:**
  - folders without a marker;
  - look-alike folders without the prefix;
  - folders whose owner is still running;
  - unregistered look-alike partials;
  - finished exports;
  - user assets;
  - other applications' files.
- It returns `{removedJobFolders, removedPartials, kept (with reasons)}`, and a second run finds nothing.
- **Wiring:** the scene renderer is not wired into the app yet (Phase 1). The app should call this once at startup, before any render. It is exposed and tested, not yet called automatically.

**Test (`tests/scene/crash.test.ts`):**
- A separate Node "app" process starts a real 1080p PNG-MOV render through `dist/` and is killed with `SIGKILL` after 10 frames.
- Exactly one job folder and one partial are left.
- On Linux, no process still refers to the job folder: the orphaned host noticed the closed connection and exited.
- Recovery removes exactly those two. The export folder still holds `client_asset.mov` and `trailer_v1.mov`, and the unfinished output was never created.
- Unit tests cover the dead, reused, live, unmarked and look-alike cases.

**Test portability:** the cancellation tests used to leave the render's rejection unobserved while they polled, which surfaced on Windows as an unhandled rejection. They now capture the outcome at once (`.then(() => null, e => e)`) and assert on it. The assertions are unchanged: the code is still `CANCELLED`, the partial is gone and no process is left.

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
- **Ownership and IPC** (`tests/scene/ownership.test.ts`): the user's processes survive every kind of job end; PID reuse; B2 stray output; the endpoint refuses outsiders.
- **Crash** (`tests/scene/crash.test.ts`): hard kill of the app, then recovery.
- **Security** (`tests/scene/security.test.ts`): the escape suite, GPU mode, CSP off, path tricks, and background traffic.
- **Parity harness** (`tests/scene/parity.ts`): a render.py-style Playwright reference (Chromium 153), compared frame by frame using SSIM, PSNR, alpha mean/max and the share of pixels differing by more than 8 levels.
  - **On the synthetic scenes, every compared frame was byte-identical** to Edissistant's (Chromium 156): opaque, transparent, 3 subframes, and 4K at device scale 2 with 4 subframes.
  - A negative control (the same scene 2 frames later) scores PSNR 21–29 dB, so the comparison does detect differences.
  - **This says nothing yet about the editor's real scenes, fonts or Windows text rendering.**
- **Benchmarks** (`tests/scene/bench.test.ts`, written to `test-results/scene/benchmark.json`):

Measured on an idle Intel(R) Xeon(R) Processor @ 2.10GHz container (4 vCPU, 17 GB, linux 6.18.44-fc-v185), software rendering. Each configuration was rendered twice, and both renders were byte-identical (decoded frames compared).

| Configuration | Frames | Output width | ms per frame | Render speed | File |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1080p30, 1 sample (no blur), PNG-MOV | 60 | 1920 px | 268 | 3.26 fps | 15.8 MB |
| 1080p30 alpha, 3 subframes (render.py default), ProRes 4444 | 60 | 1920 px | 551 | 1.69 fps | 14.9 MB |
| 1080p29.97, 3 subframes, PNG-MOV | 60 | 1920 px | 923 | 1.04 fps | 15.9 MB |
| 4K25 (device scale 2), 4 subframes + post-capture camera, 15 frames, PNG-MOV | 15 | 3840 px | 7213 | 0.14 fps | 10.6 MB |

Where the time goes:
- Every subframe is a full PNG screenshot that Chromium encodes and the host decodes. Opaque frames with full-frame gradients compress worse than mostly-empty transparent frames, so they cost more per subframe (923 vs 551 ms with 3 subframes).
- At 4K, the post-capture camera resample runs in JavaScript on every subframe.
- None of this is optimised yet. Your Windows PC (Ryzen 7 3800XT) should be considerably faster than this container, but that needs measuring.

**The bottleneck, as measured on Windows (PR #8 validation):**
- Capture is sequential: one subframe at a time, each a full DevTools PNG screenshot.
- About **300 ms per 1080p subframe**, about **830 ms per 4K subframe**, and about **1 s for each 4K post-capture camera resample**.
- Encoding, IPC and blur accumulation are small next to these.

**Options, not done in this sprint (no broad rewrite before fidelity is settled):**

| Option | Expected gain | Cost / risk |
| --- | --- | --- |
| Parallel frame ranges: N hosts, each rendering a contiguous range, with frames merged in order before encoding | Close to N× on a many-core CPU; the 3800XT has 8 cores / 16 threads | N× memory. Each host must be byte-identical; the current determinism tests already prove this across processes. The simplest big win. |
| Raw off-screen paint buffers (Electron OSR `paint` bitmaps) instead of PNG screenshots | Removes the PNG encode and decode, roughly half of the per-subframe cost | Must prove pixel-identical output (colour handling, alpha, device scale) against the current path and Playwright. |
| Camera resample in a worker thread, or native/WASM SIMD | Takes about 1 s per 4K subframe off the capture thread; with SIMD, several times faster | Must stay bit-identical to the current Catmull-Rom (a reference test exists). |
| Overlap capture with blur accumulation and encoding (pipelining) | Hides accumulation and encoding time | Small change, small gain. |
| Optional GPU rendering | Faster heavy CSS filters and canvas | GPU output can differ across drivers. Opt-in only, never the reference path. |


## Findings during Phase 0
1. **Background traffic:** Electron reaches out to Google's component updater by default. The host switches it, and all other background networking, off; a test proves no connection is made.
2. **Hidden windows:** a hidden Electron window stops painting after a navigation, so DevTools screenshots hang. Off-screen rendering fixes it, and removes the native window altogether.
3. **Helper processes:** Chromium helpers outlive the host process for 1–3 s. The original fix (a process group, `taskkill /T` on Windows) was unsafe on Windows after the host had exited, because the PID could be reused. It is replaced by owned identities (PID + start time) and verified kills; see [Process ownership](#process-ownership-and-cleanup).
4. **Blocked navigation:** a page that tries to navigate away makes `loadURL` fail with `ERR_ABORTED`. The host stays on its origin and continues, and the attempt is recorded as blocked.
5. **Own-file fetches:** `connect-src 'none'` would also block a scene from fetching its own JSON data, so fetch is allowed for the job's own origin only.
6. **Reference capture size:** in headless Playwright, the raw DevTools screenshot at device scale 2 returns CSS-pixel size (1920×1080). The reference harness uses `page.screenshot({ scale: 'device' })` there, and both sides check every frame's size.
7. **Edge resampling:** clamping the bicubic resample inside each pass biased edge positions by about 0.04 px and made pushes step unevenly. It is now clamped once at the end; error is under 0.005 px.
8. **Timer clock:** a timer's callback now sees the time it was due, not the frame time.
9. **Windows stdio (B1/B2):** Electron 45 on Windows closes the child's stdin early and writes stray CRLF to stdout. The protocol moved to an authenticated per-job socket or pipe.
10. **WebGPU in GPU mode:** `navigator.gpu` was exposed when the GPU was enabled. It is now disabled at three levels: the Chromium feature, the Blink feature, and the page shim.
11. **`window.print()`:** it stalled a frame until the frame timeout. It is now a no-op in every frame.
12. **WebRTC UDP and mDNS:** Windows saw WebRTC UDP traffic, mDNS included, despite the proxy-only UDP policy. The RTC constructors are now removed before page scripts run, in every frame, and mDNS candidates are off.
13. **Camera test:** without a device, the denial wasn't conclusive. The test now gives the host a fake device and expects `NotAllowedError`.
14. **IPC header field:** a message envelope field named `job` collided with the `open` command's payload. It is now `jobId`.

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
- **Windows:** the new socket/pipe IPC, process ownership, hardening and crash recovery are tested on Linux only. The previous Windows run (18823a1) found the blockers this sprint fixes; the fixed host still needs a clean Windows run (checklist below).
- **Speed:** CPU only (software rendering), one renderer per job, sequential capture. See the bottleneck and options under the benchmarks.
- **Post-capture camera:** the SaaS kit's exact resampling kernel and camera API are unknown (`render_ms.py` and `core.js` weren't provided). The prototype uses Catmull-Rom; the adapter will be mapped to the real `camSet` once the kit is available.
- **Not implemented:** person mattes, source-frame extraction (`prep`), the white-matte variant, post-grade filters, combined files with audio, and parallel chunks.
- **UI:** no UI yet, and no Claude calls. Scenes are fixtures standing in for Claude output.
- **Crash recovery is not called automatically yet:** `recoverAbandonedRenderArtifacts` exists and is tested, but the app calls it only once the renderer is wired in (Phase 1).

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

## Windows checklist (Phase 0, after the blocker fixes)

Run on the **shipped host, unmodified**: no harness workarounds, no local patches to `hostMain.ts`, `client.ts` or the tests.

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
2. With FFmpeg on `PATH` (and Python, if available, for the user-job survival test), run `npm run test:scene`.
   - **Expected:** every scene test passes: render, faults, ownership, crash, security and parity. The bench run is also expected to complete.
   - The Linux-only `/proc` assertions are skipped inside the tests on Windows.
   - For the parity test, install Playwright's browser first (`npx playwright install chromium`), or set `PARITY_CHROMIUM` to a Chromium executable.
3. **IPC (B1/B2):**
   - All jobs must connect without any stdin/stdout workaround.
   - The ownership suite's "stray bytes" test must pass.
   - While a job runs, `[System.IO.Directory]::GetFiles("\\.\pipe\") | Select-String edissistant-scene` shows exactly one pipe, and none after the job.
4. **Process ownership:**
   - The ownership suite's FFmpeg and Node jobs (and Python, if installed) must survive every job end.
   - Also start your own long FFmpeg encode before running the suite, and confirm it is untouched.
   - Afterwards, check `test-results/scene/ownership.json`: the host and helpers are listed, and `skipped` is empty.
5. **Crash:** the crash test must pass. Also check in Task Manager that no `electron.exe` belonging to the scene host is left after it. This is the Windows version of the orphaned-host check, which is automated only on Linux.
6. **Sandbox:** in Process Explorer, check the render host's renderer process (`--type=renderer`):
   - integrity level **Untrusted** or **Low**;
   - a restricted token;
   - not running with `--no-sandbox`.
7. **Network and hardening (Windows-only evidence):**
   - During the security suite, run `Get-NetUDPEndpoint | Where-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).Name -eq 'electron' }`. Expected: no rows, with port 5353 (mDNS) in particular absent.
   - Confirm no mail client, Settings window or dialer opened during the security suite.
   - Run the GPU-mode security test on the GPU PC: `navigator.gpu` must be undefined.
8. Check that `%TEMP%\edissistant-scene-*` folders disappear after the tests. `edissistant-scene-state` may remain; it holds only the partial registry.
9. Send:
   - `test-results/scene/benchmark.json`, `parity.json`, `ownership.json` and `security-*.json`;
   - the Vitest output.
