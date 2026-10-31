# End-to-end integration (draft)

This branch connects the three engines into one editing workflow inside the existing app:

**import footage → transcribe → suggest visuals → approve → render preview → export → revise**

It runs on the real engines: PR #1's transcription service, PR #2's sandboxed renderer and FFmpeg
pipeline, and PR #3's local deterministic planner. It is not a UI simulation.

| Engine | Branch | Commit integrated |
| --- | --- | --- |
| PR #1 Local transcription | `feature/local-transcription` | `ab032ef` |
| PR #2 Animation & rendering | `feature/animation-rendering` | `178c793` |
| PR #3 Creative planning | `feature/creative-planning` | `3357fa7` |
| #5 Timecode fix (main) | `fix/ntsc-timecode` | `c8a80b2` |

All four were merged into `feature/end-to-end-integration` (from `main` `ec16bac`) with ordinary
merge commits. The first integration merge had no conflicts. Re-syncing on 2026-10-31 resolved
`compose.ts` and `time.ts` in favour of their branches' versions.

![Graphics from the demo run, composited over the footage](images/integration-demo.jpg)

## How the pieces connect

```
Renderer (React)                                Main process
────────────────                                ────────────
Workspace / Review / Export
   │  usePipeline (one job at a time, progress, cancel, coded errors; results saved via update())
   │
   ├─ Transcribe ─────── transcription:* ────▶ PR #1 TranscriptionService (FFmpeg → whisper-cli)
   │     transcript → one row per sentence (+ word timing)
   ├─ Link source ────── pipeline:probeSource ▶ FFprobe: duration, exact frame rate, audio
   ├─ Suggest visuals ── pipeline:plan ───────▶ PipelineService → PR #3 PlanningService (local)
   ├─ Approve/Reject/
   │  New idea/concept ─ pipeline:act ────────▶  (plan synced to the rows first, then the decision)
   ├─ Render preview ─── pipeline:build ──────▶  approved plan → PR #2 SequenceSpec (validated)
   │                  └─ render:sequence ─────▶ PR #2 RenderService: renders changed segments,
   │                                              reuses the rest, composites over the source + audio
   └─ Export ─────────── render:sequence (final) → render:export (copy) → pipeline:checkMedia (verify)
```

| New code | What it does |
| --- | --- |
| `src/shared/pipeline/` | IPC contract and pure conversions: sequence rows → planner inputs, plan → row updates, approved plan → PR #2 sequence (composite, alpha or captions). A plan only renders when it matches the row as it is now. |
| `src/main/pipeline/` | `PipelineService` (planning, profiles, sequence building), validated IPC (`pipeline:*`), FFprobe source probing and export checks. |
| `src/renderer/lib/pipeline.ts`, `pages/project/usePipeline.tsx` | Request building, applying results to rows, the job runner (progress, cancel, errors, notices). |
| `src/renderer/components/PipelineStatus.tsx` | Progress bar with Cancel, then the outcome or the coded error. |
| UI changes | Workspace (Transcribe, Suggest visuals, Render preview, Source/Rendered-preview viewer), Inspector (suggestion card: approve, reject, new idea, concept, mode, stale review), sequence table (concept and suggested mode), Review (instruction editing, Regenerate, Update preview), Export (real Start render, verified results, font fallback switch), Direction (variety level). |

The renderer never gets OS access beyond the existing preload bridge. Every `pipeline:*` input is
type- and range-checked. Paths are probed read-only, and only files PR #2 rendered can be exported.

## Step by step: what works end to end (verified on Linux)

1. **Import.** New project, then choose a client preset, then Choose video. The source path is
   stored, not copied. The source is probed, and its exact frame rate (e.g. `30000/1001`) and size
   become the project's timeline when the editor hasn't set them. A moved or deleted file is
   reported before any job starts. The Source tab offers Relink.
2. **Transcription.** The Transcribe button calls PR #1's service over IPC, with progress and
   Cancel. It makes one row per sentence with real sentence timing and word timing. Replacing an
   existing sequence asks first. A file that was transcribed before comes from PR #1's cache
   instantly, so editing the transcript text never re-runs whisper. Errors are coded, e.g.
   `MODEL_NOT_FOUND`, `ENGINE_NOT_FOUND`, `FILE_NOT_FOUND`.
3. **Creative planning.** Suggest visuals runs PR #3's deterministic local planner with the
   project's preset, direction notes and variety level.
   - Each row shows its concept, suggested mode and reasoning.
   - In the inspector, the editor can Approve, Reject, ask for a New idea, pick a concept or change
     the mode.
   - Timestamps, transcript and instructions are never changed by planning.
   - Approving always applies to the suggestion the editor sees. If bringing the plan up to date
     produces a new idea (changed text or instruction, or a rejection), it is shown first and
     approval needs a second click.
   - An approved row whose text or instruction changes keeps its approval but is flagged. It won't
     render until the editor clicks Keep approval or Re-plan with the change.
4. **Animation specs.** Approved rows are converted to PR #2 specs and validated by PR #2:
   - **No code is generated.** The specs are data only; no AI-written JavaScript exists or runs.
   - **Unsupported concepts are flagged, not rendered:** `b-roll-suggestion` (footage) and
     `map-route` (no map component).
   - **Missing data or assets are reported per row,** e.g. no spoken number, or a logo sting
     without a logo.
   - **Brand fonts are strict.** A missing font stops the render with `FONT_NOT_FOUND`, unless the
     project allows a fallback font (Export tab).
5. **Rendering.** Render preview runs PR #2's renderer, with progress and Cancel:
   - It renders approved graphics at preview quality and reuses cached renders of unchanged
     segments.
   - It composites the graphics over the source footage with its audio.
   - The result is saved with the project, so a reopened project still has its preview.
6. **Preview.** The viewer switches between Source and Rendered preview (in Edit and in Review).
   - Graphics start exactly on their segment's frame on the 30000/1001 grid. The E2E test checks
     this by decoding frames: the frame before each graphic is footage, and the first frame of a
     full-frame graphic is the graphic.
   - Source audio is kept as AAC.
   - The preview's frame count matches the timeline exactly.
7. **Export.** Choose an output folder, an output type, then Start render. Every file is copied
   with PR #2's export and then checked with FFprobe (size, frame count, alpha, audio) before
   "Export complete" is shown.

   | Output | What is written |
   | --- | --- |
   | Full motion graphics | One H.264 + AAC MP4: graphics composited over the footage at the export resolution and frame rate. |
   | Transparent motion graphics | One ProRes 4444 MOV with alpha per graphic, named `<name>_<NN>_<HH-MM-SS-FF>.mov` by its timeline position. |
   | Transparent captions | One ProRes 4444 MOV with alpha per segment (word-highlight captions), named the same way with `_captions`. The existing SRT export stays available. |

   **The two transparent exports are numbered differently.** In motion-graphics files, `NN` counts
   *graphics*: only segments that render a graphic get a file, so rows with "Stay on speaker" or no
   graphic are skipped and the numbers close up. In caption files, `NN` counts *rows*: every row
   with a transcript gets a file. The same `NN` can therefore name different rows, e.g.
   `2997_07_00-00-31-29.mov` (the 7th graphic) and `2997_08_00-00-31-29_captions.mov` (the 8th row)
   start at the same moment. **Match files by the timecode, which is each clip's first frame on the
   timeline, not by the number.** Each clip is exactly as long as its span on the timeline:
   `round(end × fps) − round(start × fps)` frames, checked at export.

   Not offered, because the engine doesn't produce it:
   - A single full-length alpha track: alpha is exported per clip, positioned by timecode.
   - A ProRes composite: the composite is H.264. ProRes 422 HQ exists only per segment in PR #2.

8. **Revisions (second priority).** In Review:
   - **Comment.** The editor comments on the segment and marks it for revision.
   - **Instruction.** They edit its instruction in place, e.g. "Show it as bars". PR #3's
     local-edit parser turns plain instructions into concept, mode and pace overrides.
   - **Approve.** They approve the new suggestion.
   - **Update preview.** Only the changed segment re-renders, and every other graphic comes from
     the render cache. The E2E run reports "Rendered 1 graphic(s), reused 8 unchanged from the
     cache".
   - **Instruction on an approved segment** (Windows round 2, bug D). The row shows "Not applied
     yet" with **Apply instruction**. The Inspector offers the same, plus **Keep current graphic**.
     Applying replans that one segment with the instruction. If PR #3's local parser understood
     all of it, the new plan is approved in the same step. If it understood only part, that part
     is applied and left for review, and the notice names the rest. If it understood none of it,
     nothing changes and the notice says so. Until the editor decides, the segment is left out of
     renders. Update preview and Export then end with a warning that names it, never with a plain
     "Preview ready". A suggestion that was never approved is replanned and shown first, as before.
   - **Concept ↔ mode.** Picking a concept that needs another visual mode, or the reverse, switches
     the other one and shows a "Visual mode switched" / "Concept switched" notice.

## Fixes found by the end-to-end run, now in their own branches

The bugs were fixed in their own branches on 2026-10-31, and this branch merges those branches. It
therefore carries the same commits, and merges cleanly whichever lands first.

| Where | Problem | Fix (commit) |
| --- | --- | --- |
| PR #2 `src/main/render/compose.ts` | At NTSC rates a graphic could appear one frame late and lose its last frame. Boundaries were seconds written with 6 decimals, which can round past their own frame (1.064 s at 24000/1001 snaps to frame 26 = 1.0844166…s). | `fcb68d4`: clips are stamped by frame number in the sequence's exact frame time base (`settb=den/num, setpts=N+first`). Real-FFmpeg tests at 24000/1001 and 30000/1001 check every frame. A first attempt on this branch (half-frame offsets) fixed the start but still dropped the last frame; it is replaced. |
| PR #3 `src/shared/planning/adapter.ts` | Caption cues and words could end past the segment after rounding to 0.01 s, so PR #2 rejected the spec (`INVALID_SPEC`). | `922e972`: clamp after rounding (regression test). |
| PR #3 `src/shared/planning/adapter.ts` | Caption highlight used the first brand colour even when near-black, which is invisible on footage. | `922e972`: the first brand colour readable on dark (≥ 4.5:1), else `#ffd166`. |
| PR #3 tests | `tests/fixtures/planning/presets.json` was never committed (`.gitignore` ignores `presets.json`), so planning tests failed on a clean checkout. | `27b2389`: fixture added explicitly. |
| main `src/renderer/lib/time.ts` | Timecode display counted 29.97 as 30 fps, drifting 3.6 s per hour. | [#5](https://github.com/tdk09671-spec/edissistant/pull/5) `c8a80b2`: frames counted at the exact rate, labelled as non-drop timecode. |

**Found in real Windows testing of `6e35122`, fixed in their own branches:**

| Where | Problem | Fix (commits) |
| --- | --- | --- |
| PR #3 adapter + approvals | Picking a concept that doesn't fit the segment's mode (e.g. Kinetic headline on a Captions segment) produced a spec PR #2 rejects. Because a sequence is validated as a whole, no preview rendered. | `3357fa7`: picking a concept brings its own mode, and picking a mode brings its default concept (recorded in history). An explicit impossible pair is refused with the reason. Incompatible plans saved earlier are flagged `incompatible`. |
| PR #4 pipeline | One invalid spec blocked every graphic. | `a780a84`: each spec is validated with PR #2's validator first; a failing one is reported `invalid` and left out, and the rest render (from cache). |
| PR #1 whisperCpp | whisper.cpp ≥ 1.8 turns flash attention on by default, which silently disables DTW. | `dc483e8`: `-nfa` is added with `-dtw` only when `whisper-cli --help` lists it. An unknown flag is handled (exit 0, no output). DTW switched off is reported. |
| PR #1 timing | Sentence starts on whisper's segment boundaries (whole seconds, before the pause), so graphics appeared up to ~0.9 s early. | `651a5f1`, `1f606d8`, `89e0e70`, `ab032ef`: starts pinned to a segment boundary are moved to the speech onset measured in the extracted audio, including quiet lead-in consonants. Estimated segments are spread again. The cache key is bumped. `transcript.timing` records how times were made. |
| PR #4 UI | The missing-font error said "set allowFallback". | `a780a84`: "Install it, or go to Export → Allow a fallback font." |

**Found in the second real Windows validation of `a6fe66f` (whisper.cpp 1.9.5, GPU), fixed in their own branches:**

| Where | Problem | Root cause | Fix (commit) |
| --- | --- | --- | --- |
| PR #2 render | Out-points a frame off: 2/8 graphics at 25 fps, 5/8 at 29.97. Start frames were right. | Each clip had `round(duration × fps)` frames while its start was rounded on its own, so the last frame was `round(start·fps) + round(dur·fps) − 1` instead of `round(end·fps) − 1`. | `abefe7a`: `segmentFrames()` snaps start and end to the same grid. The renderer, composition and render cache key use it (engine version 2). Real-FFmpeg test decodes first and last frames at 25, 24000/1001 and 30000/1001. Exports now require the exact frame count (`d412312`). |
| PR #3 planning + PR #4 Review | An instruction edited in Review on an approved segment, then Approved and Update preview, rendered 0 graphics, kept the old one and said "Preview ready". | The textarea only stored text. "Approved" was already selected, and the plan wasn't stale until the next sync. Then the planner overwrote the plan's instruction and said "transcript changed", the build left the segment out, and the notice still reported success. | `34af943`: the planner keeps the instruction the approved graphic was planned with (`stale.instructionFrom`), and plain approval can't drop it. `d412312`: **Apply instruction** in Review and the Inspector replans and approves that one segment (or says what wasn't understood), and only it re-renders. Preview and Export warn about any change not in the render. UI E2E `review-instruction.spec.ts`. |
| PR #1 transcription | With DTW, small.en (with `-nfa`) dropped the last 8 s of a 40 s clip, silently. base.en was fine. | whisper.cpp 1.9.5 itself (reproduced with whisper-cli directly). The app never compared the text with the audio. | `1902fc8`: speech in the audio with no words is detected after every run. A DTW run is redone without DTW and kept if it covers more (with a warning), the remaining gaps are transcribed again from just that audio, and anything left is reported (`coverage`). DTW stays opt-in. |
| PR #1 timing | Normal mode: starts up to 0.92 s early (clean) and 2.03 s (after pauses). With music, the first start stayed 0.92 s early and wasn't counted. | The onset search ended at whisper's first-token end, which is often before the speech. Full-band volume over a music bed looked like speech already in progress, which fell through uncounted. | `1902fc8`: speech-band onsets against the local background, which must persist like speech, with a 2.5–7 kHz lead-in band and a 3 s search. Every start is moved, confirmed, uncertain or unchecked. Uncertain and unchecked starts are flagged on the word, marked ≈ on the row, and named in the notice. |
| PR #4 UX | Picking a concept that switches the visual mode gave no on-screen note. | | `d412312`: "Visual mode switched" / "Concept switched" notice. |
| Docs | Motion-graphics files are numbered by graphic, captions by row. | | `d412312`: see the Export step. |

**Found in the third real Windows validation of `94b3ddc`, addressed (timing and editor control):**

| Problem | What changed | Commits |
| --- | --- | --- |
| Starts 365–772 ms late after pauses, unflagged | These sentences start mid-segment, so they weren't anchored and were never checked. Now every sentence start is checked against the pauses in the audio. | PR #1 `465f538` |
| First sentence over music ~0.9 s early | Pause detection uses a background that stays steady across a music bed's beats and tolerates short drum and hi-hat hits. Boundaries over music are moved but flagged (about ±0.1 s). | PR #1 `465f538` |
| Sentence ends never refined (+0.4 to +2.6 s) | Ends are trimmed to where the speech stops (after a final plosive release). They never move more than 0.15 s past whisper's end, so graphics don't grow through pauses. Adjacent and overlapping speech is flagged, not guessed. | PR #1 `465f538` |
| No editor control over graphic timing | **On-screen graphic** in the Inspector: graphic in/out separate from the speech timing, snapped to exact frames (rational 29.97/23.976), ±1 frame nudges, set from the playhead, checked against the video length. Shows "Adjusted", has Reset to speech timing, persists, and re-renders only that graphic. | `fa68de6` |
| DTW only reachable programmatically | Settings → Transcription → **Precise word timing (DTW, advanced)**, off by default, with its cost and fallback explained. Each transcript says whether it used DTW, fell back, or DTW wasn't available. | PR #1 `6e06665`; here `b3c7d28` |
| Export warned about unapplied instructions only afterwards | The Export page warns before exporting, with Go to Review. Start render asks first; an export made anyway is recorded as Outdated. | `e9e8e3f` |

Integration-only change, which stays in this branch: the PR #3 adapter's `alpha` option, which gives
full-frame graphics a transparent background for graphics-only deliverables.

Planning inputs are built by `toPlanningInputs`, not PR #3's `fromProjectSegments`. The latter
treats an approved row's visual mode as an input, so writing the approved mode back to the row
would make the next run flag the approval as changed.

## Local setup for testing (Windows first)

You need Node 22, then `npm ci` and `npm start` (production build) from the repository.

**FFmpeg and FFprobe** (rendering, composition, probing, audio extraction):
- Use FFmpeg 6 or newer with `libx264`, `prores_ks` and `aac`. `libvpx-vp9` is optional (WebM
  alpha). On Windows, a "full" build from gyan.dev or BtbN works.
- Put `ffmpeg.exe` and `ffprobe.exe` in one folder. Either set Settings → FFmpeg path, or add the
  folder to `PATH`, or copy both into `%APPDATA%\edissistant\bin\`.
- Check from the app's DevTools: `await window.electronAPI.getRenderStatus()`.
- Tested here with FFmpeg 6.1.1 (Ubuntu). The `flite` filter is only needed to generate the
  synthetic test footage.

**whisper.cpp** (as in [TRANSCRIPTION.md](TRANSCRIPTION.md)):
- Unzip a Windows x64 release so that `whisper-cli.exe` ends up in `%APPDATA%\edissistant\whisper\`.
  Or set `"transcription": { "whisperPath": "C:\\…\\whisper-cli.exe" }` in
  `%APPDATA%\edissistant\settings.json`. There are no Settings fields for this yet.
- Put a model in `%APPDATA%\edissistant\models\`. `ggml-base.en.bin` (~142 MB) is fast for clean
  English. `ggml-small.en.bin` (~466 MB) is a good CPU balance.
- **No model is bundled or downloaded by the app.**
- Check from DevTools: `await window.electronAPI.getTranscriptionStatus()`.

**Fonts:**
- Every font named in the client preset must be installed on the render machine. Windows: right-click
  the font file → Install for all users.
- Built-in presets name Inter and Geist, which Windows does not ship.
- To test without them, turn on Allow a fallback font in the Export tab. That also applies to
  Render preview. A generic font is then used and the run says so.

**Footage:**
- 30–60 s with speech. Any frame rate that FFmpeg reads works. 23.976, 24, 25, 29.97, 30, 50 and
  60 are used as-is; other rates are converted to the project rate.

**Synthetic footage for a quick test.** On macOS or Linux (needs FFmpeg with `flite`):

```bash
node tests/fixtures/pipeline/make-trailer.cjs ~/edissistant-trailer
```

This writes a 35.6 s, 29.97 fps trailer with synthesised speech. On Windows, use your own clip
instead.

## Claude: prepared, not called

- `pipeline:plan` accepts `useModel: true`. That routes candidate generation through PR #3's
  `ModelConceptProvider` and `AnthropicTransport`.
- The key is read from the encrypted secrets store per request.
- Model, budget and price come from `%APPDATA%\edissistant\planning\config.json` (see
  [PLANNING.md](PLANNING.md) section H).
- **The UI never sends `useModel: true`.** Every plan in this branch is local and deterministic, and
  no paid call was made.

Still needs a real, approved API run (with a small hard limit in `config.json`):
- That the API accepts the request as built: structured-output schema, effort, refusal-fallback beta.
- Real prompt-cache hit rates, token use and cost per video.
- Real rate-limit behaviour.
- Whether model suggestions beat the local planner. No quality claim is made.
- A UI control to opt into model planning, with the cost estimate shown first. It is not built yet,
  on purpose.

## Tests

```bash
npm run typecheck && npm run test:unit && npm run build && npm run test:e2e
```

**New unit and integration tests (Vitest, `tests/unit/pipeline/`, 34 tests):**

| Area | Tests |
| --- | --- |
| Conversions | rows → planner inputs; word timing kept only while it matches. |
| Plan → rows | status and mode mapping; transcript, timing and instructions never touched. |
| Status → actions | the editor action for each status pick. |
| Approved plan → sequences | composite, alpha and captions sequences validated by PR #2 at 23.976, 25 and 29.97. |
| Stale plans | rows changed since planning are reported, not rendered. |
| Captions | rounding regression; highlight legibility. |
| Composition timing | sweep of 6 rates × 200 clips; NTSC timecode format and parse round-trip over 10 minutes of frames. |
| Media | FFprobe probing (29.97 + AAC, silent footage, ProRes 4444 alpha, broken file, no FFprobe). |
| `PipelineService` | deterministic planning; approvals survive a restart; never approving unseen suggestions; invalid transitions refused; valid PR #2 sequence from approved rows only; selective regeneration (unchanged specs byte-identical, so PR #2 reuses its cache); project notes. |
| Full flow (outside Electron) | media → PR #1 service (real FFmpeg, stand-in whisper) → rows → plan → approvals → validated sequence; transcript cache; missing media and missing model. |

**New E2E tests** (`tests/e2e/pipeline.spec.ts`, real app):

- **The vertical slice:** New project, preset, link footage (29.97 adopted), Transcribe (rows
  match the speech timing to within 20 ms), Suggest visuals, Reject and new idea, approve all,
  Render preview.
  - The preview has AAC audio, frames at 30000/1001, and the exact frame count.
  - Each graphic starts on its frame.
  - All three exports are verified with FFprobe.
  - The app is then closed and reopened, and everything is still there.
  - Review revision: comment, instruction, approve twice, Update preview. Exactly one segment is
    rendered and the rest are reused.
- **Failure paths:** cancel a transcription (nothing changes), `MODEL_NOT_FOUND`, cancel a render
  part-way (no preview saved), and a missing source file.

**The one stand-in:** `whisper-cli` is PR #1's fake engine fed the transcript of the synthesised
speech. That's because there is no model in this container, and Hugging Face is blocked here.
Everything else is real:

- FFmpeg audio extraction from the actual video
- PR #1 sentence grouping and word interpolation
- planning
- the sandboxed Chromium renderer
- FFmpeg encoding and composition
- export copy and FFprobe verification

**Linux results (2026-10-31, from a clean clone of the pushed branch):**
- `npm ci`, typecheck and build pass.
- Unit tests: 429 passed, 2 skipped.
- E2E: 34/34 passed as a normal user.
- As root, PR #1's 4 `launcher.spec.ts` tests fail because Electron refuses root without `--no-sandbox` (details in [TESTING.md](../TESTING.md)).
- Transcription in these tests uses the stand-in `whisper-cli`. Real whisper.cpp was not run here.

## Windows validation checklist (integrated app)

Run these in PowerShell on Windows 11 with the setup above. Record the results in `TESTING.md`.

1. **Automated checks.** `npm ci; npm run typecheck; npm run test:unit; npm run build; npm run test:e2e`.
   - Unit tests should pass.
   - The new `pipeline.spec.ts` skips on Windows: its stand-in engine needs a POSIX shell. Use steps
     2–9 instead.
2. **Real transcription.** Create a project with your client preset and link a 30–60 s clip with
   speech. Click Transcribe. Then check:
   - progress shows
   - the rows match the speech
   - timecodes look right at your clip's frame rate
   - a second Transcribe asks to replace, then finishes instantly (cache)
3. **Plan and decisions.** Click Suggest visuals, then:
   - approve some rows
   - reject one and use New idea
   - change one concept and one visual mode in the inspector
   - check that transcript, in/out and instructions didn't change
4. **Fonts.** With a preset font that isn't installed, Render preview must stop with "A brand font is
   not installed". With Allow a fallback font on, it renders.
5. **Preview.** Click Render preview. Then:
   - play the Rendered preview with sound
   - check each graphic starts with its sentence
   - at 29.97 or 23.976, step frame by frame across a graphic's start
6. **Cancel.** Cancel a render and a transcription part-way. Task Manager must show no `ffmpeg.exe`,
   `whisper-cli.exe` or extra Edissistant renderer process left over.
7. **Export.** Export all three output types to a folder whose name contains spaces and an accent.
   - Open the MP4 in your player and the MOVs in Premiere or Resolve: alpha should be present, and
     clips go at their timecode.
   - Also export the SRT.
8. **Reopen.** Close and reopen the app: the project, its approvals and the preview are still there.
   Move the source file away: Render preview must say it was moved or deleted. Relink it.
9. **Revision.** In Review:
   - comment and mark a segment for revision, then change its instruction
   - approve it (twice: the first click shows the new idea), then Update preview
   - the notice should say 1 rendered and the rest reused
10. **Round 2 re-checks** (the bugs found in the second Windows validation):
   - **Instruction on an approved segment:** Review → an approved segment → type "Show it as bars."
     → "Not applied yet" shows. Update preview first: it must end with a warning naming the segment,
     not "Preview ready". Then Apply instruction → "Instruction applied" → Update preview: 1
     rendered, the rest reused, and the new graphic is in the preview.
   - **Out-points:** export Transparent motion graphics at 25 and 29.97. Each MOV's `nb_read_frames`
     must equal `round(end × fps) − round(start × fps)`. Back-to-back graphics must neither overlap
     nor leave a gap in Premiere.
   - **DTW truncation:** transcribe clip A with small.en and DTW (through the bridge, as before). The
     transcript must be complete, with a warning that DTW was dropped for small.en. Repeat with
     base.en: complete, DTW times, no warning.
   - **Normal-mode starts:** clips A, B, C1 and C2 without DTW. Unflagged rows should be within about
     a frame of the true onset. Rows marked ≈ in the sequence table, and named in the transcription
     notice, may be off (music, overlap). No row should be early by more than 0.1 s without being
     marked.

11. **Round 3 re-checks** (timing and editor control):
   - **Boundaries without DTW:** clips A, B, C1 and C2 with base.en and small.en. Unflagged starts
     and ends should be within about a frame of the truth. Rows marked ≈ (start or end) may be off
     by about 0.1 s over music, or more where sentences run together. B row 4 ("Honestly…") and A
     small.en "Subscribe now…" should no longer be late. Ends should no longer hold through the pauses.
   - **Graphic in/out:** in the Inspector, change a graphic's in/out at 25, 23.976 and 29.97. The
     values snap to frames, the row shows "Graphic adjusted", and Render preview says "Rendered 1".
     The exported MOV is exactly `round(out × fps) − round(in × fps)` frames, starting at the in
     frame in its timecode name. Reopen the project: the timing is kept. Reset: the speech timing
     comes back.
   - **DTW setting:** Settings → Transcription → Precise word timing. With small.en on clip A, the
     notice must say DTW lost speech and standard timing was used, and the transcript must be
     complete. With base.en it must say DTW alignment. With the setting off, the command line has no
     `-dtw` or `-nfa`.
   - **Export warning:** with an unapplied instruction, the Export page shows the warning before
     anything is written. Start render asks first; Export anyway gives an Outdated record.

## Known limitations

- The whisper path and models folder are set in `settings.json` (as in PR #1); there are no Settings
  fields yet.
- One job runs at a time per project. Leaving the project cancels a running job.
- Alpha deliverables are one clip per graphic, positioned by timecode in the file name. There is no
  single full-length alpha track and no XML/EDL timeline export yet.
- Planning is local only. Model planning is wired in the main process but has no UI and hasn't been
  validated.
- The E2E vertical slice runs on Linux and macOS only, because of the stand-in whisper-cli.
  `review-instruction.spec.ts` needs no stand-in, so it runs on Windows wherever FFmpeg is installed.
- Sentence boundaries come from pauses in the audio, not from a voice model. Over a music bed they
  are flagged (about ±0.1 s). Where sentences run together or voices overlap there is no pause to
  measure, so the boundary is left as whisper gave it and flagged. The editor's graphic in/out is the
  tool for those.
- DTW is an advanced setting, off by default. It still needs real-world validation on Windows (see
  round-3 checks).
- Segment ids are random, and they seed the planner's tie-breaking. The same project always plans
  the same way, but two projects with the same transcript can get different (equally valid) concept
  mixes.
