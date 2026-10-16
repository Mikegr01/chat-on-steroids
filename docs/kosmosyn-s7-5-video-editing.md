# S7.5 video editing workflow

The Core `video_editing` tool prepares a bounded editing job for one durable local session and one Resolve project. The request, source evidence, candidate plans, selected preparation, operation claim, and receipts belong to `src/main/video-editing/store.ts`. A local project association does not grant filesystem access; paths still require approved-root admission. The curated Resolve plugin is an optional dependency and its discovery is not execution authority.

## Workflow and ownership

1. `create` freezes a strict work request. `ingest` admits source media and records measured evidence. `source-usability` reports usable source ranges; `set-usable-ranges` requires the current binding and revision. Missing usable ranges remain unusable.
2. `submit` accepts bounded candidate designs from an operator/planner provider. `select` chooses one candidate. `prepare` binds it to a specific, observed timeline; `preview` and `preflight` expose the proposed operation and fresh conditions without dispatching it.
3. A native operator inspects the exact job in Setup, authorizes its prepared fingerprint, and separately confirms native execution. IPC resolves the job and current state in main; the renderer supplies fixed selectors rather than arbitrary operations. The native principal is distinct from an MCP CallContext and does not impersonate a conversational request.
4. The coordinator remeasures target and adapter state, consumes one authorization, and durably claims the operation before curated dispatch. A claimed or ambiguous operation is never replayed. `reconcile` only observes. Technical acceptance requires complete post-state evidence. Historical jobs lacking the new native proof remain ineligible.

Readmission of adapter source-end semantics or capabilities requires a fresh native receipt and an unchanged revision. `recover-legacy-prepared` is limited to receiptless, unexecuted historical preparation and does not grant authority to run it. The first accepted live operation is a guarded append to a fresh, empty, adapter-owned target in a dedicated acceptance project or timeline; render and creative mutations remain outside that first scenario. The older S7 production path and unattended Category C authority remain closed.

## Frame contract

Logical source and timeline ranges are half-open: `[start,end)`. `execution.ts` converts a logical source end to the admitted adapter's inclusive wire end. The curated adapter then translates that wire end to Resolve 21.1.1 append semantics at one adapter-to-Resolve boundary. Each conversion belongs to its named boundary; no downstream layer adds another compensation.

The offline acceptance example is 24 fps: source A `[0,24)` maps to V1 `[0,24)`; source B `[0,24)` maps to V1 `[24,48)`. The expected result is 48 frames, two video items, and no audio items. `test/video-frame-contract.test.ts` exercises adjacent cuts and 1, 2, 23, 24, 25, and 48 frame round trips through compiler, adapter, and verifier. These tests prove the integrated contract in a fake backend; they do not claim this branch was run against a live Resolve installation.

## Runtime, Windows verification, and packaging

Advanced Media Runtime admits explicit absolute FFprobe/FFmpeg paths after native confirmation. It bounds probe/decode output and stores immutable bounded frame evidence. It does not discover executables through `PATH` or install tools. The curated Resolve adapter has fixed exposed tools and retains plugin installation and epoch checks.

Windows UCV uses a native helper with bounded request/response types and fixed main/preload methods. The isolated fixture creates only its own Electron window and stops before verification; the availability diagnostic does not activate a protected production context. The native build is wired into the current Vite/package flow and the packaged payload smoke checks the helper. Windows UCV availability is a device fact, not proof that a video operation is authorized.

Source, tests, build and package checks are separate evidence levels. No live Resolve mutation is part of repository verification. The public `origin/main` base for this reconciliation has no S4 browser protocol subsystem, so the historical S4 expiry test is not included; see [the reconciliation audit](s75-origin-main-reconciliation.md).
