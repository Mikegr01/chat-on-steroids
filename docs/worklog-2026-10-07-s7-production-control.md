# S7 production operator control candidate

Source/test/build candidate for independent HEAD review; no acceptance declaration.

## Starting custody and isolation

- Canonical: `D:\MAIN FOLDER\00_TOOLS\Chat-On-Steroids-Custom`, branch `custom/main`.
- Exact starting HEAD: `98fa2108be3957fe9d19c3806373bb0e2555f83a`.
- Canonical status: only unstaged `M THIRD-PARTY-NOTICES.txt`; staged/untracked counts both zero.
- Notice dirty boundary: 267 added / 281 removed lines, hunks `-1204,29 +1203,0`,
  `-1370,252 +1340,0`, `-203871,0 +203591,238`, `-203899,0 +203857,29`.
- Canonical notice SHA256: `0261A7783DA17EC3C466FF37A73D457A602BFE71C07C25EE304FAD55F2B85A57`.
- Protected accepted worktree: `Chat-On-Steroids-Custom-kosmosyn-s7`, branch
  `feature/kosmosyn-s7-authority`, exact same HEAD, clean; read only.
- Repair branch/path did not exist. Created `repair/kosmosyn-s7-production-control` at
  `D:\MAIN FOLDER\00_TOOLS\Chat-On-Steroids-Custom-s7-control` from the exact HEAD.
- Recent relevant commits: `98fa210` S7 selective authority, `569da04` S6 controlled canary,
  `a29c4fd` S5 decision shadow, `c3f2604` S4 durable probe, `0e5232f` read-only completion.
- Worktree inventory also contained davinci-v1, IDENTITY, mcp-plugin-integration,
  mcp-plugin-repair, photoshop-v1, release-98fa2108, s7-ui-baseline, two review exports,
  and `I:/Photos storage/ADOBE/TEMP/cos-readiness-98fa2108-20261006`. No repair ownership collision.

## RED before implementation

First edit was only the authority test:
`rejects schema-valid non-empty custody when uninitialized without overwriting it`.
It creates valid terminal custody through the existing test authority, changes the test gate
to uninitialized/Off, then initializes a new authority against that exact custody.

Command against unchanged production source at starting HEAD:
`node_modules/.bin/vitest.cmd run test/kosmosyn-s7-authority.test.ts -t "rejects schema-valid non-empty custody when uninitialized"`.

Exit 1; one failed and 54 skipped. Exact pre-fix failure:
`AssertionError: promise resolved "undefined" instead of rejecting`, at
`test/kosmosyn-s7-authority.test.ts:36:40`. Initialization accepted the schema-valid non-empty
ledger, exactly the defect under repair. The test was not made RED by breaking production wiring.

## Implementation boundary

- `s7-authority.ts`: reject non-empty uninitialized custody; accept existing empty retry
  without a write; reject invalid strict reads; validate initialized custody without rewriting it.
  `validateInitialized()` and recovery behavior remain unchanged.
- `config.ts`: `getKosmosynS7State`, `initializeKosmosynS7`, `setKosmosynS7Enabled`.
  Initialization invokes the real singleton authority, then durably persists initialized/Off.
  Repetition validates custody and returns existing state, including Enabled, without a config rewrite.
- Config mutation queue is acquired first. The initialization updater awaits and releases the
  authority's own queue before the existing persist callback takes that queue again for validation
  and config publication. No callback holding authority enters the config queue. Deferred-queue
  tests cover initialization followed by enable/disable; normal config edits retain serialization.
- Config write failure leaves the published gate uninitialized/Off and retains its empty ledger;
  retry validates the same generation and completes. Enable requires prior initialization and the
  unchanged initialized-custody validator. Disable persists Off without reading custody, retaining
  initialization and terminal/tombstone bytes. Initialization cannot be reset.
- IPC: only `kosmosynS7:state`, `kosmosynS7:initialize`, `kosmosynS7:set-enabled`.
  No-payload requests accept only undefined; set-enabled accepts only boolean. Mutation errors
  are bounded operator messages, without raw filesystem diagnostics.
- Preload: only the three corresponding dedicated methods. No arbitrary invocation, ledger/path
  access, test hook, uninitialize, or generic settings mutation is exposed.
- Setup → Advanced: narrow operator section, three requested state labels, Initialize button,
  Enable S7 checkbox. Eligibility and busy state disable controls. Dedicated operation replies
  and reads own repainting; failed operations refresh published main state. Later ordinary
  Settings replies cannot overwrite this section with a stale gate snapshot.
- The integration fixture uses these production controls instead of manually bootstrapping config.
  Settings:save schema and SettingsPatch still omit S7. Tests prove generic save cannot bootstrap it.
- No browser-wake/command/input/receipt/startup owner was changed. Tests assert no control-command
  or wake side effect; initialized/Off ordinary admission retains legacy behavior.
- Shared Protocol, S6, S8 and unrelated integration/runtime code were not changed.

## Verification

Final focused and adjacent run: 12 files / 415 tests passed (includes all 216 focused tests).
Includes S7 authority/control/integration/protocol, IPC, preload, renderer control,
config, renderer state/HTML/layout and renderer localization-source checks.
Typecheck and build passed. Diff whitespace check passed.

Initial default-concurrency `npm run verify:ci`: privacy, notices, native sources and typecheck
passed; broad tests reported 292 files / 7318 tests passed, five files / 52 tests skipped,
and one Blender ownership test timed out at its unchanged 30000ms limit. This is a recorded failed
run, not a PASS. The full frozen-source rerun with `VITEST_MAX_WORKERS=2` exited 0:
293 main files / 7321 tests passed, five files / 52 tests skipped, then two serialized
native/shutdown files / 26 tests passed. Privacy passed (730 commits, 18 tags); notices passed
(154 production packages, 10 catalog entries); native-source checks passed (730 pinned archives/patches).

Initial UI gate: 34/37, exit 1, only the three accepted historical failures. Detailed
candidate and exact starting-HEAD reruns used unchanged assertions and reproduced:

| Check | Matching failure signature |
| --- | --- |
| message-reactions | `verify-message-reactions.cjs:71:14`: bubble Y 79 vs 109, answer Y 217.9166717529297 vs 247.9166717529297, scroll 30 vs 0. Full assertion snippets compare equal. |
| plan-collapse | `verify-plan-collapse.cjs:123:12`: `A panel after plan completion still animates`; actual false, expected true. |
| workspace-terminal | `verify-workspace-terminal.cjs:178:18`: timeout waiting for `.match(/PS C:/g)` count greater than zero; both outputs show a `PS D:` project prompt. |

No candidate assertion, fixture, timeout or Vite asset allowlist was changed. Vite font
allowlist warnings occurred in both detailed reaction/terminal reruns and did not prevent
reaching the matching historical assertions. The final frozen-source full `npm run verify:ui`
also exited 1 at 34/37, with exactly those same three failures, no fourth failure and no
candidate-specific regression. It is a successful differential comparison, not an absolute UI PASS.
Raw candidate logs are ignored `outputs-s7-*.log` in the repair root. An ignored exact
starting-HEAD Git archive under `.tmp/s7-control-ui-baseline` is used solely for baseline
UI signature comparisons; it is not an additional managed worktree or an installed app.

## Execution deviation

The first PowerShell dependency-junction command used a relative target and failed. The following
`npx vitest` unexpectedly installed Vitest 5.0.3 and its dependencies in the npm `_npx` cache.
This was an execution error relative to the no-install instruction; it was not a production app
install or a repository dependency/lockfile update. The corrected absolute-target junction reuses
existing canonical dependencies; all reported RED/GREEN runs use local Vitest 5.0.0. The cache
installation is disclosed rather than falsely reporting that no installation of any kind occurred.
No cleanup of shared npm cache was attempted.

## Production safety

No app package/install/upgrade, production config/ledger edit or initialization/enablement,
live S7 canary/Send, browser composer action, extension reload, Resolve/project/archive mutation,
Official CoS mutation, S8 work, Goal/Loop/Orchestrator start, commit, merge, rebase, push, or
canonical notice write was performed. Required CI tests may exercise packaging code in their
own temporary synthetic fixtures; no distribution/package command was invoked for the candidate.

## Final review state

Starting and current HEAD both remain `98fa2108be3957fe9d19c3806373bb0e2555f83a`.
Branch: `repair/kosmosyn-s7-production-control`. Staged files: zero. Untracked files: four.
Complete porcelain status / exact diff boundary (only these 15 files):

```text
 M AGENTS.md
 M src/main/browser-transport/s7-authority.ts
 M src/main/config.ts
 M src/main/ipc.ts
 M src/preload/index.ts
 M src/renderer/index.html
 M src/renderer/main.ts
 M test/ipc.test.ts
 M test/kosmosyn-s7-authority.test.ts
 M test/kosmosyn-s7-integration.test.ts
 M test/preload-images.test.ts
?? docs/worklog-2026-10-07-s7-production-control.md
?? src/renderer/kosmosyn-s7-control.ts
?? test/kosmosyn-s7-control.test.ts
?? test/renderer-kosmosyn-s7-control.test.ts
```

Canonical branch/HEAD/status remain the starting values; its notice hash and dirty boundary
are unchanged. The protected accepted S7 worktree remains clean at its starting branch/HEAD.

```text
PACKAGE_OR_INSTALL_EXECUTED=YES (unintended npm tool-cache installation only; no CoS app packaging/install)
PRODUCTION_S7_INITIALIZED=NO
PRODUCTION_S7_ENABLED=NO
LIVE_S7_SEND_EXECUTED=NO
BROWSER_SEND_MESSAGE_EXECUTED=NO
RESOLVE_MUTATION_EXECUTED=NO
S8_STARTED=NO
OFFICIAL_COS_TOUCHED=NO
CANONICAL_NOTICE_FILE_TOUCHED=NO
```

No unresolved source/test/build repair blocker remains. However, the requested unconditional
no-install attestation cannot truthfully be made: `BLOCKER=NO_INSTALL_ATTESTATION_NOT_MET`
due to the disclosed tool-cache installation. Acceptance belongs to the independent HEAD reviewer.
