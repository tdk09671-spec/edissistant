# Continuous integration

One GitHub Actions workflow, [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), checks every
pull request on Linux and Windows: clean install, typecheck, production build, unit tests and the
Electron end-to-end tests. It builds nothing for release and publishes nothing.

## When it runs

| Event | Runs? |
| --- | --- |
| Pull request into `main` or `feature/end-to-end-integration`: opened, new commits, reopened | Yes, unless the PR is a **draft** |
| Draft PR marked **Ready for review** | Yes |
| Draft PR (any push) | No. The run appears with skipped jobs and uses no runner minutes |
| Push to `main` (a merge) | Yes |
| Manual: Actions → CI → **Run workflow** | Yes |
| Pushes to other branches, tags, schedules | No |

A new push to the same PR cancels that PR's run in progress, so only the latest commit is tested.
Pushes to `main` share one queue the same way.

## What it checks

Two jobs run in parallel. A third, **CI passed**, succeeds only when both succeed; it is the one
check to require in branch protection.

| Step | Linux (`ubuntu-24.04`) | Windows (`windows-2025`) |
| --- | --- | --- |
| Clean install: `npm ci` (exact versions from `package-lock.json`, Node from `.nvmrc`) | ✓ | ✓ |
| Electron binary download (checksum-verified by Electron's installer, cached) | ✓ | ✓ |
| Environment check: `scripts/ci/check-env.mjs` | Fails without FFmpeg + FFprobe (libx264, prores_ks, aac, flite), the Inter font, or when run as root | Report only |
| Typecheck: `npm run typecheck` (renderer and main) | ✓ | ✓ |
| Production build: `npm run build` | ✓ | ✓ |
| Unit tests (Vitest), then `verify-skips.mjs` | ✓ everything runs except 2 allowed skips | ✓ FFmpeg-dependent tests allowed to skip |
| Electron E2E (Playwright `_electron`, real built app), then `verify-skips.mjs` | ✓ all specs, under Xvfb, normal user, sandbox on | ✓ except the 3 FFmpeg specs |
| `check-tracked-fixtures.mjs`: tests left no untracked files in `tests/` or `scripts/` | ✓ | ✓ |
| On failure: upload `playwright-report/`, `test-results/` (traces, screenshots), `ci-reports/` | 7 days | 7 days |

What the regression tests cover: synthetic fixtures; fractional frame rates (24000/1001, 30000/1001)
and first and last graphic frames; captions; incompatible concepts and modes; approvals and
revisions; project persistence and recovery; cancellation and subprocess cleanup; safe spec
validation; cache reuse and selective regeneration. They are listed in [TESTING.md](../TESTING.md)
and the engine docs. CI runs the existing suites; it doesn't change them.

### Guards that keep a green check honest

- **No silent skips.** Many tests skip when FFmpeg is missing, which is right on a laptop but would
  turn a misconfigured runner green. `verify-skips.mjs` reads the JSON reports and fails on any
  failure, an empty run, or a skip that isn't in [`scripts/ci/allowed-skips.json`](../scripts/ci/allowed-skips.json)
  for that OS. Every allowed skip has a reason, and the log lists every skipped test.
- **No hidden files.** A clean checkout only has what Git tracks, so a fixture that exists only on a
  developer's machine (the `presets.json` incident) fails CI. Run
  `node scripts/ci/check-tracked-fixtures.mjs` before pushing to catch it locally.
- **No secrets, no paid calls.** The token is read-only (`contents: read`), checkout doesn't keep
  credentials, and no secret is referenced. Claude planning reads its API key only from the app's
  settings, which every test isolates in an empty folder, so it fails with `NO_API_KEY` before any
  request. The Claude E2E tests (`claude.spec`, once merged) use a fake key against a mock Anthropic
  server on `127.0.0.1`, which the app accepts only in test mode. Transcription uses a stand-in for whisper.cpp, so no model is downloaded and no GPU is needed.
- **Sandbox stays on.** The Linux job runs as the runner's normal user and checks it isn't root.
  Ubuntu 24.04 blocks the unprivileged user namespaces Chromium's sandbox prefers, so the job makes
  Electron's bundled `chrome-sandbox` helper setuid root (Chromium's documented fallback). It never
  uses `--no-sandbox`.

### Allowed skips

| Where | Test | Why |
| --- | --- | --- |
| Linux, unit | `referenceAnalysis` › on `PLANNING_REFERENCE_VIDEO` | Opt-in, needs the editor's own reference video |
| Linux, unit | `whisperCpp` › Unicode model paths on Windows | Windows only; runs in the Windows job (and must not skip there) |
| Windows, unit | Any test in: `planning/referenceAnalysis`, `pipeline/flow`, `pipeline/media`, `render/compose`, `render/encoder`, `render/service`, `transcription/ffmpeg`, `transcription/onsets`, `transcription/service`, `transcription/coverage`, `transcription/onsetScenes`, `transcription/boundaries` | Need FFmpeg, some with libflite or a POSIX shell. All run on Linux |
| Windows, E2E | `pipeline.spec`, `transcription.spec`, `rendering.spec`, `dtw-setting.spec`, and the tests that render or export in `review-instruction.spec`, `graphic-timing.spec`, `export-warning.spec` and `claude.spec` | Need FFmpeg (and a POSIX shell for the stand-in engines); all run on Linux |
| Linux, E2E | None | |

To allow a new skip, add an entry with a reason. To allow one test, give `"test"` as its full name
(describe titles plus test title, separated by spaces).

## How long it takes

Measured on 2026-10-31 by replaying the Linux job as a non-root user on a fresh clone, in an
Ubuntu 24.04 container with a warm npm cache. Runner times are estimates, not measurements:
**this workflow has not run on GitHub yet.**

| Step | Measured locally | Expected on runner |
| --- | --- | --- |
| apt install FFmpeg, fonts, Xvfb | n/a (preinstalled) | 1–2 min |
| `npm ci` + Electron download | 5 s (warm cache) | 0.5–1.5 min |
| Typecheck + build | 3 s | 20–40 s |
| Unit tests (486) | 18 s | 20–40 s |
| E2E (41 tests) | 5 min 55 s (`pipeline.spec` about 4 min) | 6–9 min |
| **Linux job** | | **about 8–12 min** |
| **Windows job** (no apt; E2E about 40 s of tests) | not run | **about 5–8 min** |

Each job has a 30-minute timeout.

## When a check fails

1. Open the failed run (PR → **Checks**, or the **Actions** tab) and expand the first red step.
   - **Check the test environment**: a tool is missing on the runner. The message names it.
   - **verify nothing unexpected was skipped**: lists failed tests, then skipped tests (`✗` = not
     allowed) and why. An unexpected skip means a tool is missing or a skip condition changed.
   - **Tests left no untracked files**: a test wrote into `tests/` or `scripts/`, or a fixture
     wasn't committed. The message lists the files.
2. Download the **test-reports-linux** or **test-reports-windows** artifact (run page → Artifacts).
   - `playwright-report/index.html`: open with `npx playwright show-report playwright-report`.
   - `test-results/**/trace.zip`: step-by-step replay with `npx playwright show-trace <file>`.
   - `ci-reports/vitest.json`, `ci-reports/playwright.json`: the raw reports.
   Video and audio files are excluded from the artifact.
3. Reproduce locally with the same commands:

```bash
npm ci
```

```bash
node scripts/ci/check-env.mjs --require-media   # Linux; on Windows run it without the flag
```

```bash
npm run typecheck && npm run build
```

```bash
npx vitest run --reporter=default --reporter=json --outputFile.json=ci-reports/vitest.json && node scripts/ci/verify-skips.mjs --vitest ci-reports/vitest.json
```

```bash
PLAYWRIGHT_JSON_OUTPUT_NAME=ci-reports/playwright.json npx playwright test --reporter=list,json,html; node scripts/ci/verify-skips.mjs --playwright ci-reports/playwright.json
```

   On headless Linux, prefix the Playwright command with `xvfb-run -a`. Don't run E2E as root:
   Electron refuses to start as root with its sandbox on.

Never re-run a red job just to get green. A test that fails only sometimes is a bug to fix. Don't
skip or delete it.

## What CI does not check (manual before a release)

CI uses synthetic media, a stand-in whisper.cpp, no Claude API and CPU-only runners, so these
still need a person on a real machine:

- **Real whisper.cpp on Windows**: a real model (`ggml-base.en` or larger), CPU and GPU (CUDA or
  Vulkan) builds, DTW word timing with `-nfa` on whisper.cpp 1.8+, sentence-start accuracy on real
  speech, a Unicode Windows user folder with the real binary.
- **GPU paths**: anything `device: 'gpu'`; there are no GPU runners.
- **FFmpeg on Windows**: CI runs the FFmpeg tests on Linux only. Check rendering and transcription
  with the FFmpeg build editors install on Windows.
- **NLE round trip**: import the exported ProRes 4444 with alpha, H.264 previews and caption files
  into Premiere Pro, DaVinci Resolve and Final Cut Pro. Check the first and last frames, alpha, frame
  rate (23.976/29.97) and timecode.
- **Claude planning with a real key**: paid, opt-in. Do it by hand with a test key and a small
  transcript.
- **Real client media**: long files, unusual codecs, variable frame rate. Never commit these.
- **Visual review of the UI** on Windows at 100% and 150% scaling.

## Making CI required (branch protection)

Turn this on only **after the workflow is on `main`**. A required check that never reports blocks
every PR.

1. Merge so `.github/workflows/ci.yml` is on `main`, then let one run finish so GitHub learns
   the check name.
2. Repository **Settings → Rules → Rulesets → New branch ruleset** (or **Settings → Branches →
   Add branch protection rule**). Target `main`, and `feature/end-to-end-integration` if you want.
3. Enable **Require a pull request before merging** and **Require status checks to pass**. Add
   **CI passed**, and enable **Require branches to be up to date before merging** if you want
   every PR re-tested on the latest `main`. That re-run costs minutes.
4. Leave **Do not allow bypassing** off if you still want to merge by hand in an emergency.

Branch protection and rulesets on a **private** repository need GitHub Pro, Team or Enterprise.
On GitHub Free the check still runs and shows on each PR, but GitHub won't block the merge.

A skipped check counts as passing, which is why draft PRs (all jobs skipped) look green. Drafts
can't be merged, and marking one ready runs CI for real.

## Cost (private repository)

This repository is private, so Actions minutes count against the account's monthly allowance.
At the time of writing that is 2,000 minutes on Free and 3,000 on Pro. **Windows minutes count
double** and each job rounds up to the next whole minute. Check current allowances and rates on
GitHub's billing pages before relying on them.

| Per run (estimate) | Billed minutes | Counted against allowance |
| --- | --- | --- |
| Linux job | 8–12 | 8–12 |
| Windows job | 5–8 | 10–16 (×2) |
| CI passed | 1 | 1 |
| **Total** | | **about 20–30** |

So roughly 65–100 full runs a month fit in a 2,000-minute allowance. What keeps the count down:
drafts don't run, a new push cancels the old run, and there's no schedule, matrix or retry. The
Electron download and npm packages are cached.

If minutes get tight, the cheapest change is to run the Windows job only on pushes to `main`
(add `if: github.event_name != 'pull_request'` to it).

By default GitHub sets a $0 spending limit on personal accounts. When the allowance runs out, jobs
stop running rather than billing you. Check **Settings → Billing and plans** before raising it.

## Maintenance

- **Action versions** are pinned to major tags (`actions/checkout@v4`, `actions/setup-node@v4`,
  `actions/cache@v4`, `actions/upload-artifact@v4`). For stricter supply-chain control, pin each to
  a full commit SHA, with the tag in a comment. Dependabot (`.github/dependabot.yml`,
  `package-ecosystem: github-actions`) can keep SHAs current. It isn't enabled because each of its
  PRs would trigger a CI run.
- **Node** comes from `.nvmrc`. Change it there, not in the workflow.
- **Runner images**: `ubuntu-24.04` and `windows-2025` are pinned rather than `-latest`, so an image
  rollover can't change the OS under the tests. Update them deliberately.
