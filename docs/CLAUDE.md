# Claude planning (V1, bring your own key)

V1 uses Anthropic Claude for creative planning, with the editor's own Anthropic API key.
Transcription (whisper.cpp) and rendering (FFmpeg) stay on the editor's computer. Claude is optional:
everything works without a key, and local planning stays the default.

> **Status:**
> - Built and tested on Linux, with mocked Anthropic responses only.
> - **No real API request has been made, and no paid credit has been used.**
> - Windows validation and a small, approved real-API experiment come next (see the checklists below).
> - **This is not production-ready** until both have passed.

## For the editor

### Set up (once)
1. **Settings → Claude API → Planning provider: Anthropic Claude.**
2. Paste your key from the Anthropic Console (API keys) and click **Save key**.
   - The key is encrypted with Windows' credential protection (DPAPI, through Electron `safeStorage`) and stored in `%APPDATA%\edissistant\secrets.bin`.
   - It is never shown again, never written to a settings or project file, and never sent to the app's window.
3. Click **Test connection**.
   - This asks Anthropic's Models API whether the key can use the selected model.
   - It is free: no tokens are used.
4. Optional:
   - **Model:** default `claude-opus-5-5`. Any model id can be typed.
   - **Warn at:** an amount per project.
   - **Project limit.**
   - **Monthly limit:** across all projects.

These limits are Edissistant's, checked on this computer against estimates. **They are not Anthropic
billing caps.** To cap what Anthropic can charge, also set a spend limit in the Anthropic Console.

### Generate with Claude
1. Open a project with a transcript and click **Generate with Claude** (or **Ask Claude** in the Inspector for a single segment).
2. The dialog shows, **before anything is sent**:
   - **Sent to Anthropic:**
     - The transcript rows that would be sent, with their timing and editor instructions.
     - **Your own words, word for word, each with its own tick box (ticked by default):** the preset's creative brief, its branding notes, and this project's notes. Each can be previewed. Unticked text is not sent.
     - **A style summary, always sent:** brand font names and colours, motion and layout traits, and short rules the app took from the preset (it can quote them). The dialog shows it exactly as it will be sent.
     - File paths (source, logo, references) are never sent.
     - Optional: the preset's reference links (as text; Claude can't open them).
     - Optional: reference images you tick (PNG, JPEG or WebP; about 1,600 input tokens each).
   - **Never sent:**
     - The source video and audio.
     - Reference videos.
     - Other projects.
     - Anything else on the computer.
   - **Cost:**
     - **Estimate, before sending:** the expected cost, and the most it could cost.
     - The number of requests, and how many are answered free from earlier identical requests.
     - What was spent so far on this project, and this month across all projects.
     - **Project limit** and **Monthly limit**, each labelled, as you set them.
     - A warning when the project has passed, or this run would likely pass, your **Warn at** amount.
   - **This project's Claude usage history.**
3. **Send to Claude** starts one request (more only for long projects: up to 12 rows per request). Every run asks first.
4. Rows Claude planned are marked **Claude**. Nothing is approved for you: review each row, then approve, edit, reject or ask again.
   - A rejected row goes back to Claude next time, with the rejected concept excluded.
   - An instruction typed on a row ("make it a counter") goes with that row next time.
5. The notice after a run shows:
   - the requests sent;
   - **input tokens** (everything Anthropic read, with the part read from the prompt cache given separately);
   - **output tokens**;
   - the **cost calculated from those counts** at Edissistant's prices.
   If the project has passed your Warn at amount, the notice is a warning and says so.
6. The project's usage history, and Settings → Usage, have separate **Input tokens**, **Output tokens** and **Calculated cost** columns. Before sending it's an *estimate*; afterwards it's *calculated* from Anthropic's token counts. Neither is your bill: the Anthropic Console is.

### What is sent, and what isn't
- **Which rows are sent:**
  - Rows planned locally that you haven't decided yet.
  - New, changed and rejected rows.
  - With **Ask Claude**, just that row.
- **Rows that are kept and not sent:**
  - Approved and edited rows.
  - Rows that already have a Claude suggestion and haven't changed.
- **Free re-runs:**
  - Running Claude again on an unchanged project sends nothing.
  - An identical request (same rows, brief, model and settings), even from another project, is answered from a local cache of earlier answers: not sent, not billed.
- **Previews, exports and reopening** use the saved plan: they never call Claude.

### When something goes wrong
A failed run changes nothing (plan, approvals, renders) and is **never retried automatically**.

| What happened | What you see |
| --- | --- |
| Key rejected | "API key rejected": replace it in Settings, then test |
| No credit | "No Anthropic credit left": add credit in the Console (Plans & Billing) |
| Rate limited / overloaded | Wait a minute and run again |
| No internet | "No connection to Anthropic" |
| Timeout (90 s by default) | Try again or with fewer rows; Anthropic may still have billed it |
| Claude's answer fails the checks | Not used; it was billed and appears in usage |
| A limit would be passed | Refused in the dialog before anything is sent |
| Cancelled | Nothing changed; a request that already reached Anthropic may still be billed |

## How it works

### Trust boundary
- **The Electron main process is the only place the key exists.**
  - It is read from `secrets.bin` for each request and passed straight to the Anthropic SDK.
  - It is never cached in memory between requests, never logged, and never put in a message.
- **What the renderer gets:** booleans (`keyStored`, `encryptionAvailable`) and outcomes, never the key.
- **Error messages:** passed through `redactSecrets` (strips `sk-ant-…`).
- **Storage:**
  - `settings:save` strips any `claudeApiKey`.
  - `planning/config.json` refuses anything that looks like a key.
- **If the OS can't encrypt** (no `safeStorage`), the key is not stored at all, rather than stored in plain text.

### What the prompt contains
- **System prompt, cached across requests:**
  1. The fixed planning instructions and the concept catalog.
  2. The style summary.
  3. If any are ticked, the editor's own texts, each in an `<editor_brief kind="creative-brief|branding-notes|project-notes">` block.
     - They are taken from the same validated request the plan is built from, not from a separate field.
     - Only `<`, `>` and `&` are entity-encoded, so the wording is otherwise exactly as typed.
     - Claude is told to follow them where they fit the content, and that they can't change the output format or the concept catalog.
- **User message:**
  - The transcript rows (as untrusted data).
  - Ticked reference links (as untrusted notes).
  - Ticked images.
- **Cache key:** changing a ticked text changes the request, so a cached answer for the old wording is never reused.

### Claude's output is data, never code
- **Request shape:**
  - Claude answers through structured outputs (`output_config.format: { type: 'json_schema' }`).
  - The schema's concept ids are an enum of the renderer's catalog.
- **Checks on every answer:**
  - It must parse.
  - Segment ids must match the request.
  - Concepts must be known.
  - Text and numbers must appear in the transcript.
- **Unknown concepts** are dropped, with a warning.
- **Choosing the concept:** the local planner still applies variety, brand rules and feasibility. Each row's `source` says honestly whether Claude's or the local candidate was used.
- **Rendering:**
  - Specs are built locally from the validated plan and checked by the renderer's validator before rendering.
  - Nothing Claude returns is executed.
- **Untrusted input:** transcript text and reference notes are wrapped as untrusted data, and the instructions tell Claude never to follow them.

### Cost controls
- **Before a request (`pipeline:estimate`):**
  - It runs the same planner pass and builds the same requests as the real run, sending nothing.
  - Input tokens are estimated from the prompt text, plus about 1,600 per image.
  - **Expected cost** assumes `900 + 250 × rows` output tokens per request.
  - **Maximum cost** assumes the full output allowance for every request.
  - Prices come from the versioned table (`DEFAULT_PRICING`, or `pricing` in `config.json`).
  - A model with no price is costed at the dearest model in the table.
- **Limits:**
  - A request whose maximum could pass the project limit, or the monthly limit, is refused before it is sent.
  - This is checked again before the request itself.
- **Usage records:**
  - Every response Anthropic returns is recorded in `planning/usage/<projectId>.jsonl`: tokens, model, time, estimated cost and pricing version.
  - A failed or invalid run is recorded too.
  - The Settings dashboard and the run dialog read these files.
- **No automatic retries:**
  - The SDK runs with `maxRetries: 0`, and editor runs make one attempt, with no second attempt after an invalid answer.
  - Only one run per project at a time: a double click can't pay twice.
- **Response cache:**
  - `planning/model-cache/<sha256>.json` holds validated answers (never the prompt or the key).
  - The key is the hash of the exact request.

### Model, SDK and API
- **Checked on 2026-10-31** against Anthropic's current API reference: model `claude-opus-5-5` ($4 / $20 per million input / output tokens; cache read $0.20), SDK `@anthropic-ai/sdk` 1.3.0 (the latest on npm), and structured outputs through `output_config.format`.
- **Refusals:** the server-side refusal fallback beta is on (`server-side-fallback-2026-07-01`). `refusalFallback: false` in `config.json` turns it off.
- **Prompt caching:** the frozen instructions and concept catalog, and the client's style summary, are marked for caching. A real run will show whether they reach the minimum cacheable size.
- **The model is configurable:** in Settings, or `models["creative-planning"]` in `config.json`. Nothing else hard-codes it.

### IPC channels (main process)

| Channel | Returns | Notes |
| --- | --- | --- |
| `ai:status` | provider, `keyStored`, `encryptionAvailable`, model, last test, config issue | No key |
| `ai:setProvider` | status | `local` or `anthropic`; stored in `planning/ai.json` |
| `ai:test` | `{ ok, model, displayName? }` or `{ ok: false, code, message }` | Models API, free; cleared when the key or model changes |
| `ai:config:get` / `ai:config:set` | model, limits, known models, pricing version | Writes `planning/config.json`, keeps every other setting; an invalid file is reported, never overwritten |
| `ai:usage` | per-project totals, this month, optional history | Estimates, not the bill |
| `pipeline:estimate` | `PlanEstimate` (rows that would be sent, costs, limits, `blockedBy`) | Sends nothing |
| `pipeline:plan` with `useModel: true` | `PlanOutcome` + `run` (this run's tokens and cost) | Refused unless Claude is chosen and a key is stored; editor policy; cancellable by `jobId` |
| `pipeline:cancel` | boolean | Aborts the SDK request |
| `secrets:set` / `secrets:delete` / `secrets:status` | booleans | Unchanged from before; set/delete clear the last test |

Reference images are read and checked in the main process:
- Only PNG, JPEG and WebP are accepted, checked by content, not just the name.
- Each image can be at most 3.75 MB, and at most 4 can be sent.
- Paths must be absolute.

### Test mode
The E2E tests point the real SDK at a local mock of the Anthropic API through
`EDISSISTANT_ANTHROPIC_BASE_URL`. The app honours it only when all of these hold:
- `EDISSISTANT_TEST_APPDATA` is set (the E2E launcher), the app is not packaged, and the URL is plain HTTP on `127.0.0.1`, `localhost` or `[::1]`.

So a stray variable can't send the key anywhere else. Editors never set environment variables.

## Tests

All mocked, with no network and no real key:

| Suite | What it covers |
| --- | --- |
| `tests/unit/planning/claudeRun.test.ts` | Editor policy: one attempt for rate limit, overload, network, timeout and 5xx; invalid answer: one call, usage recorded, no plan; cache across projects and unchanged projects; estimate; project and monthly limits; cancel; references and brand summary in the prompt; 402 and legacy-400 credit errors; connection test ok / 401 / 404 / network |
| `tests/unit/pipeline/ai.test.ts` | Provider choice; connection test uses the stored key and returns no key; test cleared on key or model change; config written with other settings kept, bad values refused, invalid file not overwritten; runs refused while local or keyless; estimate → run → no resend; failures change nothing; one run per project; cancel; reference checks (video, fake PNG, size, missing, relative); no key in any file written |
| `tests/unit/pipeline/ai.test.ts` (round 5) | Ticked brief texts reach the system prompt word for word; unticked texts, unselected images, file paths and the source never do; the style summary shown is the one sent; changing the brief changes the request; Warn at warns before and after a run; the estimate shows the configured project limit; a monthly cap is named as monthly |
| `tests/e2e/claude.spec.ts` | Real UI, real main process and the real Anthropic SDK against a loopback mock: Settings key save, test, replace, remove, unknown model, limits; Generate with Claude → consent → Claude rows → approve → nothing to resend → usage dashboard → reopen sends nothing; preview and export send nothing (needs FFmpeg); 401 / 402 / 429 / dropped connection / invalid answer change nothing, with no retries; cancel; project limit refuses before sending; the key never appears in the page, any data file or the logs |

## Windows testing checklist

Run on Windows 11 with this branch, before any real API call. **Use a placeholder key** (any
`sk-ant-…` string) except in the last section.

**Automated**
1. `npm ci`, `npm run typecheck`, `npm run build`, `npm run test:unit`, `npm run test:e2e`. All pass. The FFmpeg-dependent tests need FFmpeg on `PATH`. The Claude E2E tests use a local mock, so no network is needed.

**Key storage (DPAPI)**

2. Settings → Claude API → **Anthropic Claude**, save a placeholder key. "API key stored securely" appears and the field is cleared.
3. Check that the key is nowhere in plain text:
   ```powershell
   Select-String -Path "$env:APPDATA\edissistant\*.json","$env:APPDATA\edissistant\planning\*" -Pattern "sk-ant" -SimpleMatch
   ```
   → no output. `secrets.bin` exists and isn't readable text.
4. Restart the app: the key is still stored. **Remove** deletes `secrets.bin`.
5. Run the app as another Windows user, or copy `secrets.bin` to another PC: the key can't be decrypted there, and the app shows no key rather than an error.

**Without network** (placeholder key, Wi-Fi off)

6. **Test connection** → "Failed", with a clear message about the connection. No crash.
7. Generate with Claude → the dialog shows rows, the estimate and the never-sent list; **Send** → "No connection to Anthropic", and the plan is unchanged.
8. Local **Suggest visuals**, approve, **Render preview** and **Export** still work.

**Wrong key** (network on, placeholder key)

9. **Test connection** → "Failed": key rejected. This uses the free Models API. Check that the Console shows no usage.

**Dialog and limits**

10. Set **Project limit** to `0.01` → Generate with Claude → refused in the dialog, and **Send** is disabled.
11. Reference images: add a PNG and a video to a preset. In the dialog only the PNG can be ticked; the video is listed under "Never sent".
12. Check the UI at 100% and 150% scaling: Settings → Claude API, the dialog, and the notices.

**First real API experiment (only with explicit approval)**

13. Use your own key with a Console spend limit set, and the app's **Project limit** at `0.50`. Then:
    - Test connection → Connected.
    - Open a short project (5–10 rows): the dialog's estimate should be a few cents.
    - Send. Then record:
      - whether the API accepted the request (structured outputs, effort, refusal-fallback beta);
      - the input and output tokens and estimated cost the app shows, against the Console's usage for that minute;
      - whether the suggestions are useful;
      - whether any row fell back to local.
    - Run again unchanged → "Nothing to send". Change one row → only that row is sent.
    - Render and export a Claude plan.
14. Report the results. Production readiness depends on them.

## Not done yet (honest list)
- **Real API:**
  - No real request has been made.
  - Not yet confirmed: that the API accepts the request as built, real token counts, prompt-cache hit rates, cost per trailer, and suggestion quality against the local planner.
- **Windows:**
  - Round 5 (fbd8b9c) verified key storage, the mock Claude flow, privacy safeguards, limits, rendering and export.
  - The round-5 corrections below still need a Windows retest.
- **Not wired to Claude yet:**
  - Plain-language instructions the local parser doesn't understand are not sent to Claude on approval.
  - They go with the row on the next Claude run.
- **Not implemented:**
  - Vision analysis of reference *videos*. Only still images can be shown to Claude, and only when ticked.
  - Parameter refinement (`refineParams`) is implemented and tested in PR #3 but not called by the app.
- **Estimates:**
  - They use Edissistant's price table. If Anthropic changes prices, update `pricing` in `config.json`.
  - The Console is the source of truth for charges.

## Known limitations and findings (Windows round 5)
- **Small windows:** the Sequence table is at least 940 px wide (`min-w-[940px]`, fixed columns). In a narrower panel, for example with the Inspector open on a small screen, it scrolls sideways inside its panel instead of reflowing. This existed before Claude and is not changed here: a proper fix means a responsive table layout, a separate change.
- **"Send" button missing (investigated):**
  - The dialog footer can't scroll out of view: it is fixed below a scrolling body.
  - Two causes were found in the code:
    1. **A toast covered it.** Toasts sat in the bottom-right corner above every dialog, which is exactly where Send is, for 3.5–6 s after any notification.
       - Fixed: while a dialog is open, toasts move to the top of the window.
    2. **By design, Send is replaced by "Open Settings"** when Claude is turned off or no key is stored. A notice says which.
  - If Send is still missing when neither applies, note what was on screen. Nothing else in the code removes it.
- **Dependency advisory (GHSA-4528-x5fx-h6hg, joi):**
  - **Chain:** `wait-on@9.5.1 → joi@18.3.0`. It is a development dependency, used only by the `npm run dev:electron` script to wait for the Vite dev server.
  - **Exposure in the app:** none. It isn't loaded by the app or the tests, and the vulnerable function (`string().email({ multiple: true })`) isn't used by wait-on.
  - **Fix:** the lockfile pins joi 18.3.1, a patch release inside wait-on's own `^18.2.9` range with identical dependencies (lockfile-only change). `npm audit` reports 0 vulnerabilities.
- **Windows E2E secret scan:**
  - While the app runs, the tests read only Edissistant's own files, because Windows locks some of Chromium's files.
  - After every Claude test the app is closed and the whole data folder is scanned, Chromium's caches and Local Storage included. The key is searched for in UTF-8 and UTF-16.
  - A file still locked after 10 s fails the test; nothing is skipped.
  - A self-test plants a key to prove the scan catches it.

## Windows retest checklist (round 5 corrections)
1. `npm ci`, `npm run typecheck`, `npm run build`, `npm run test:unit`, `npm run test:e2e` on `feature/claude-planning`.
   - The 3 earlier E2E failures (locked Chromium files) should be gone.
   - `claude.spec` now has 7 tests. One renders, so it needs FFmpeg.
2. **Brief:**
   - Give a preset a creative brief and branding notes, and a project some notes.
   - Generate with Claude: each text has its own box, ticked, with a preview. The style summary preview shows the exact text that is always sent.
   - Untick branding notes. The estimate's input tokens drop a little.
3. **Reference image:**
   - Add a broken image to the preset: rename a text file to `.png`.
   - Tick it in the dialog: an error shows, and the image boxes stay visible.
   - Untick it: the estimate comes back and Send is enabled.
4. **Toasts:** with the dialog open, any toast appears at the top right, never over Send.
5. **Warn at:**
   - Set **Warn at** to `0.01` and leave the project limit empty.
   - The dialog shows a warning-amount notice.
   - With a placeholder key nothing is sent, so the after-run warning is covered by the E2E test and the real experiment.
6. **Limit labels:**
   - Set **Project limit** `5` and **Monthly limit** `10`. The dialog shows "Project limit: $5.00" and "Monthly limit: $10.00" separately.
   - Set **Monthly limit** `0.01`: the refusal names the monthly limit.
7. **Usage:** Settings → Usage has separate Input tokens, Output tokens and Calculated cost columns.
8. **Small screen:** the Sequence table limitation above is expected, not a regression.
