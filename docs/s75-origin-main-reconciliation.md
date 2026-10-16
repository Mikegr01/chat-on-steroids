# S7.5 origin/main reconciliation audit

Base: `e63508ebd3187bac2865c7dcad7537de2f06611a` (`origin/main`, fetched 2026-10-16). Accepted source: `94120c9432260bb6b383530d759e745ea9c35676..45d19c937ed41d9eb1c798d391344bcc8f62f6c7` (25 commits). The 38 earlier local-only commits are outside this range. This inventory records accepted history; classification does not imply transplanting a commit or every file it touched.

## Accepted commit inventory

### 1. `9d54639d02255820251e61209e0ed1c5c5c61d72` — feat(video-editing): add guarded preparation and evidence acquisition

Classification: `S75_CORE`. Purpose: Guarded request, preparation, and evidence model.

Paths (34): `AGENTS.md`, `docs/kosmosyn-s7-5-video-editing.md`, `docs/worklog-2026-10-08-kosmosyn-s7-5-execution.md`, `docs/worklog-2026-10-08-kosmosyn-s7-5-foundation.md`, `src/main/mcp/tools-plugins.ts`, `src/main/plugins/davinci-adapter-source.ts`, `src/main/video-editing/analysis.ts`, `src/main/video-editing/authority.ts`, `src/main/video-editing/execution.ts`, `src/main/video-editing/identity.ts`, `src/main/video-editing/inspection.ts`, `src/main/video-editing/perception.ts`, `src/main/video-editing/planning.ts`, `src/main/video-editing/producers.ts`, `src/main/video-editing/review.ts`, `src/main/video-editing/revision.ts`, `src/main/video-editing/runtime-inspection.ts`, `src/main/video-editing/store.ts`, `src/main/video-editing/validation.ts`, `src/shared/video-editing.ts`, `test/fixtures/davinci-adapter-contract.py`, `test/fixtures/video-editing.ts`, `test/fixtures/video-observation.ts`, `test/plugins-davinci.test.ts`, `test/plugins-surface.test.ts`, `test/video-editing-domain.test.ts`, `test/video-editing-execution.test.ts`, `test/video-editing-inspection.test.ts`, `test/video-editing-perception.test.ts`, `test/video-editing-planning.test.ts`, `test/video-editing-producers.test.ts`, `test/video-editing-review.test.ts`, `test/video-editing-runtime.test.ts`, `test/video-editing-store.test.ts`.

### 2. `b88f890897c6c1f8baaa6a60e925f60febc6c62a` — feat(video-editing): wire persistent preparation workflow and preflight

Classification: `S75_CORE`. Purpose: Persistent workflow/preflight ownership.

Paths (25): `AGENTS.md`, `docs/kosmosyn-s7-5-video-editing.md`, `docs/worklog-2026-10-08-kosmosyn-s7-5-workflow.md`, `src/main/video-editing/execution.ts`, `src/main/video-editing/planning.ts`, `src/main/video-editing/producers.ts`, `src/main/video-editing/runtime-inspection.ts`, `src/main/video-editing/store.ts`, `src/main/video-editing/validation.ts`, `src/main/video-editing/workflow-guards.ts`, `src/main/video-editing/workflow-ingestion.ts`, `src/main/video-editing/workflow-output.ts`, `src/main/video-editing/workflow-planning.ts`, `src/main/video-editing/workflow-preview.ts`, `src/main/video-editing/workflow-state.ts`, `src/main/video-editing/workflow.ts`, `src/shared/video-editing.ts`, `test/fixtures/video-workflow-runtime.ts`, `test/fixtures/video-workflow.ts`, `test/video-editing-runtime.test.ts`, `test/video-output-contract.test.ts`, `test/video-work-request.test.ts`, `test/video-workflow-guards.test.ts`, `test/video-workflow-inputs.test.ts`, `test/video-workflow.test.ts`.

### 3. `7ca796df9de305ee51aa97b39ec54f11cfa7d279` — docs(video-editing): record operator MVP media runtime dependency gate

Classification: `S75_DOCS`. Purpose: Media runtime dependency record.

Paths (2): `docs/kosmosyn-s7-5-video-editing.md`, `docs/worklog-2026-10-08-kosmosyn-s7-5-operator-dependency-gate.md`.

### 4. `cffc6087bb94660ded17b114b0620321ab01f33c` — feat(video-editing): admit external media runtime and operator preparation

Classification: `S75_CORE`. Purpose: External media runtime admission and operator preparation.

Paths (41): `AGENTS.md`, `docs/kosmosyn-s7-5-video-editing.md`, `docs/worklog-2026-10-08-kosmosyn-s7-5-operator-media-runtime.md`, `src/main/config.ts`, `src/main/index.ts`, `src/main/ipc.ts`, `src/main/mcp/surfaces.ts`, `src/main/mcp/tools-core.ts`, `src/main/mcp/video-editing-tool.ts`, `src/main/video-editing/media-images.ts`, `src/main/video-editing/media-output.ts`, `src/main/video-editing/media-probe.ts`, `src/main/video-editing/media-runtime.ts`, `src/main/video-editing/operator-authorization.ts`, `src/main/video-editing/operator-ipc.ts`, `src/main/video-editing/operator-preflight.ts`, `src/main/video-editing/runtime-inspection.ts`, `src/main/video-editing/service.ts`, `src/main/video-editing/store.ts`, `src/main/video-editing/validation.ts`, `src/main/video-editing/workflow-guards.ts`, `src/main/video-editing/workflow-ingestion.ts`, `src/main/video-editing/workflow-output.ts`, `src/main/video-editing/workflow-preview.ts`, `src/main/video-editing/workflow.ts`, `src/preload/index.ts`, `src/shared/media-runtime.ts`, `src/shared/types.ts`, `src/shared/video-editing.ts`, `src/shared/video-operator.ts`, `test/feature-parity.test.ts`, `test/mcp.test.ts`, `test/video-media-host.test.ts`, `test/video-media-images.test.ts`, `test/video-media-output.test.ts`, `test/video-media-runtime.test.ts`, `test/video-media-workflow.test.ts`, `test/video-operator-ipc.test.ts`, `test/video-operator-service.test.ts`, `test/video-workflow-owner.test.ts`, `test/video-workflow.test.ts`.

### 5. `a71450927fb4d6063f15913fd7f2bf0ea917344f` — feat(video-editing): enforce operator dispatch and prepare guarded live acceptance

Classification: `S75_ACCEPTANCE_SUPPORT`. Purpose: Guarded dispatch and acceptance preparation.

Paths (21): `AGENTS.md`, `docs/kosmosyn-s7-5-video-editing.md`, `docs/worklog-2026-10-08-kosmosyn-s7-5-live-execution-preparation.md`, `src/main/mcp/video-editing-tool.ts`, `src/main/plugins/davinci-adapter-source.ts`, `src/main/video-editing/operator-execution.ts`, `src/main/video-editing/operator-preflight.ts`, `src/main/video-editing/producers.ts`, `src/main/video-editing/runtime-inspection.ts`, `src/main/video-editing/service.ts`, `src/main/video-editing/store.ts`, `src/main/video-editing/workflow-guards.ts`, `src/main/video-editing/workflow-output.ts`, `src/shared/video-editing.ts`, `test/fixtures/davinci-adapter-contract.py`, `test/fixtures/video-operator-execution.ts`, `test/plugins-davinci.test.ts`, `test/video-editing-runtime.test.ts`, `test/video-media-workflow.test.ts`, `test/video-operator-execution.test.ts`, `test/video-operator-live-service.test.ts`.

### 6. `fe92b47072da39a6b32b1e89b052aff731ec03ba` — feat(video-editing): expose media runtime operator admission

Classification: `S75_ACCEPTANCE_SUPPORT`. Purpose: Operator-facing media runtime admission.

Paths (21): `AGENTS.md`, `docs/worklog-2026-10-08-kosmosyn-s7-5-media-runtime-operator-route.md`, `scripts/verify-video-media-runtime.cjs`, `src/main/ipc.ts`, `src/main/mcp/video-editing-tool.ts`, `src/main/video-editing/media-runtime-operator.ts`, `src/main/video-editing/media-runtime.ts`, `src/main/video-editing/operator-ipc.ts`, `src/main/video-editing/service.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/main.ts`, `src/renderer/video-media-runtime.ts`, `src/shared/media-runtime.ts`, `test/renderer-video-media-runtime.test.ts`, `test/video-media-core.test.ts`, `test/video-media-operator-host.test.ts`, `test/video-media-operator.test.ts`, `test/video-media-runtime.test.ts`, `test/video-operator-ipc.test.ts`, `test/video-operator-live-service.test.ts`.

### 7. `f42ad6994c5094794904767b9cb898949a3961b5` — build(nsis): add opt-in state-preserving abort diagnostics

Classification: `PUBLICATION_UNSUITABLE`. Purpose: Installer abort diagnostic scratch instrumentation, omitted.

Paths (7): `AGENTS.md`, `docs/worklog-2026-10-09-kosmosyn-s7-5-installer-abort-diagnostic.md`, `scripts/nsis-diagnostic-hook.cjs`, `scripts/nsis-diagnostic.cjs`, `scripts/package.mjs`, `scripts/verify-nsis-diagnostic.cjs`, `test/nsis-diagnostic.test.ts`.

### 8. `b347197e1719efbb786996027851ef9beed2acf5` — docs(s7.5): record verified diagnostic package and one-run gate

Classification: `PUBLICATION_UNSUITABLE`. Purpose: Local diagnostic package and gate notes, omitted.

Paths (1): `docs/worklog-2026-10-09-kosmosyn-s7-5-installer-abort-diagnostic.md`.

### 9. `a5e6f4e36c1987cae2e04405e966eecfc9bd0faf` — fix(installer): apply all-users ACL after elevation

Classification: `S75_PACKAGING`. Purpose: Move sandbox ACL grant to post-elevation install hook.

Paths (6): `AGENTS.md`, `docs/worklog-2026-10-09-kosmosyn-s7-5-installer-acl-repair.md`, `scripts/verify-windows-installer-acl.cjs`, `scripts/windows-installer-acl.nsh`, `test/packaging.test.ts`, `test/windows-installer-acl.test.ts`.

### 10. `787b924add41d40c8ba3bb009bbb60255a853f1c` — fix(video-editing): support standalone session ownership

Classification: `S75_CORE`. Purpose: Bind standalone session owner.

Paths (21): `AGENTS.md`, `docs/kosmosyn-s7-5-video-editing.md`, `docs/worklog-2026-10-09-kosmosyn-s7-5-session-ownership-repair.md`, `src/main/mcp/video-editing-tool.ts`, `src/main/plugins/davinci-adapter-source.ts`, `src/main/video-editing/operator-execution.ts`, `src/main/video-editing/producers.ts`, `src/main/video-editing/runtime-inspection.ts`, `src/main/video-editing/service.ts`, `src/main/video-editing/workflow-guards.ts`, `src/shared/video-acceptance-target.ts`, `src/shared/video-editing.ts`, `test/fixtures/davinci-adapter-contract.py`, `test/fixtures/video-operator-execution.ts`, `test/mcp-tool-declarations.test.ts`, `test/plugins-davinci.test.ts`, `test/video-editing-runtime.test.ts`, `test/video-operator-execution.test.ts`, `test/video-operator-live-service.test.ts`, `test/video-session-ownership.test.ts`, `test/video-standalone-workflow-service.test.ts`.

### 11. `2a68c88af15c458c7175a22ff34a082c1ddcbe9e` — fix(video-editing): normalize standalone project scope

Classification: `S75_CORE`. Purpose: Normalize standalone project scope.

Paths (6): `AGENTS.md`, `docs/kosmosyn-s7-5-video-editing.md`, `docs/worklog-2026-10-09-kosmosyn-s7-5-session-ownership-repair.md`, `src/main/video-editing/service.ts`, `test/video-session-ownership.test.ts`, `test/video-standalone-workflow-service.test.ts`.

### 12. `b2516c00b35bdcd4bc40a66926a954f2eb1b6497` — fix(video-editing): paginate exact Resolve media discovery

Classification: `S75_CORE`. Purpose: Paginate exact Resolve discovery.

Paths (6): `AGENTS.md`, `docs/kosmosyn-s7-5-video-editing.md`, `docs/worklog-2026-10-08-kosmosyn-s7-5-workflow.md`, `src/main/video-editing/inspection.ts`, `src/main/video-editing/workflow-ingestion.ts`, `test/video-media-discovery.test.ts`.

### 13. `024bdca2747e5ad89e86dced0393d5d081609fcf` — fix(video-editing): separate media inventory from source validation

Classification: `S75_CORE`. Purpose: Separate inventory from validation.

Paths (7): `AGENTS.md`, `docs/kosmosyn-s7-5-video-editing.md`, `docs/worklog-2026-10-08-kosmosyn-s7-5-workflow.md`, `src/main/video-editing/inspection.ts`, `src/main/video-editing/media-inventory.ts`, `src/main/video-editing/producers.ts`, `test/video-media-discovery.test.ts`.

### 14. `7e033857b701e72f3c595d7c443ea3f06551c9f1` — fix(video-editing): add durable post-ingest usable ranges

Classification: `S75_CORE`. Purpose: Persist post-ingest usable source ranges.

Paths (15): `AGENTS.md`, `docs/kosmosyn-s7-5-video-editing.md`, `docs/worklog-2026-10-08-kosmosyn-s7-5-workflow.md`, `src/main/mcp/video-editing-tool.ts`, `src/main/video-editing/service.ts`, `src/main/video-editing/source-usability.ts`, `src/main/video-editing/store.ts`, `src/main/video-editing/validation.ts`, `src/main/video-editing/workflow-preview.ts`, `src/main/video-editing/workflow-state.ts`, `src/main/video-editing/workflow.ts`, `src/shared/video-editing.ts`, `test/fixtures/video-source-usability.ts`, `test/video-source-usability-service.test.ts`, `test/video-source-usability.test.ts`.

### 15. `aaad0750dbac287088f876ac6d987e319d6b5b80` — fix(video-editing): support same-job source-end readmission

Classification: `S75_CORE`. Purpose: Readmit source end in same job.

Paths (13): `docs/worklog-2026-10-10-kosmosyn-s7-5-source-end-readmission-repair.md`, `src/main/mcp/video-editing-tool.ts`, `src/main/plugins/manager.ts`, `src/main/video-editing/runtime-inspection.ts`, `src/main/video-editing/service.ts`, `src/main/video-editing/source-end-admission.ts`, `src/main/video-editing/store.ts`, `src/main/video-editing/workflow-state.ts`, `src/main/video-editing/workflow.ts`, `src/shared/plugins.ts`, `src/shared/video-editing.ts`, `test/fixtures/video-source-usability.ts`, `test/video-source-end-readmission.test.ts`.

### 16. `3635ba8fb7afa21e34a1f81c65f8a25f7a60ad94` — fix(video-editing): require native receipt for capability readmission

Classification: `S75_CORE`. Purpose: Require native receipt for readmission.

Paths (13): `docs/worklog-2026-10-11-kosmosyn-s7-5-capability-confirmation-repair.md`, `src/main/ipc.ts`, `src/main/video-editing/operator-ipc.ts`, `src/main/video-editing/runtime-inspection.ts`, `src/main/video-editing/service.ts`, `src/main/video-editing/source-end-admission.ts`, `src/main/video-editing/store.ts`, `src/main/video-editing/workflow-state.ts`, `src/main/video-editing/workflow.ts`, `src/preload/index.ts`, `src/shared/video-editing.ts`, `test/video-capability-confirmation-receipt.test.ts`, `test/video-source-end-readmission.test.ts`.

### 17. `df9362a630ca33082f8d69c6055d85f08f49326a` — fix(video-editing): recover legacy unexecuted preparation

Classification: `S75_CORE`. Purpose: Recover legacy unexecuted preparation.

Paths (10): `AGENTS.md`, `docs/worklog-2026-10-11-kosmosyn-s7-5-legacy-prepared-recovery.md`, `src/main/mcp/video-editing-tool.ts`, `src/main/video-editing/legacy-prepared-recovery.ts`, `src/main/video-editing/service.ts`, `src/main/video-editing/store.ts`, `src/main/video-editing/workflow-state.ts`, `src/shared/video-editing.ts`, `test/video-legacy-prepared-recovery-mcp.test.ts`, `test/video-legacy-prepared-recovery.test.ts`.

### 18. `13a8dfe165f7efb7adf5f9bd97fb515891a273a3` — fix(video-editing): expose native operator controls

Classification: `S75_UI`. Purpose: Expose native operator UI controls.

Paths (6): `AGENTS.md`, `docs/worklog-2026-10-11-kosmosyn-s7-5-operator-controls.md`, `src/renderer/index.html`, `src/renderer/main.ts`, `src/renderer/video-operator-controls.ts`, `test/renderer-video-operator-controls.test.ts`.

### 19. `8bffaf90621ee143f979d19b389a5173c3a1bdb3` — test(kosmosyn): add Windows verification diagnostics

Classification: `S75_WINDOWS_UCV`. Purpose: Windows UCV diagnostic and fixture tests.

Paths (18): `native/windows-ucv-diagnostics/reference.cpp`, `scripts/windows-provider-diagnostic-boundary.mjs`, `scripts/windows-provider-diagnostic.mjs`, `scripts/windows-ucv-availability-diagnostic.mjs`, `scripts/windows-ucv-fixture.mjs`, `src/diagnostics/windows-provider/collect.ts`, `src/diagnostics/windows-provider/contract.ts`, `src/diagnostics/windows-provider/entry.ts`, `src/diagnostics/windows-provider/native.ts`, `src/diagnostics/windows-provider/synthetic.ts`, `src/diagnostics/windows-ucv-fixture/entry.ts`, `test/windows-provider-diagnostic-boundary.test.ts`, `test/windows-provider-diagnostic-entry.test.ts`, `test/windows-provider-diagnostic-native.test.ts`, `test/windows-provider-diagnostic.test.ts`, `test/windows-ucv-availability-diagnostic.test.ts`, `test/windows-ucv-fixture-entry.test.ts`, `test/windows-ucv-fixture.test.ts`.

### 20. `8e5c8ed7aae13f39f59188e2af07d9f7dd8e2975` — feat(kosmosyn): complete guarded S7.5 execution and packaging

Classification: `S75_CORE`. Purpose: Guarded native execution, frame contract, packaging.

Paths (61): `electron-builder.yml`, `electron.vite.config.ts`, `native/windows-ucv/ucv.cpp`, `scripts/build-windows-ucv.mjs`, `scripts/package.mjs`, `scripts/smoke-packaged-runtime.mjs`, `scripts/windows-ucv-package-smoke.mjs`, `src/main/control-api.ts`, `src/main/durable.ts`, `src/main/ipc.ts`, `src/main/plugins/davinci-adapter-source.ts`, `src/main/plugins/manager.ts`, `src/main/video-editing/capability-operator-proof.ts`, `src/main/video-editing/execution.ts`, `src/main/video-editing/native-execution-principal.ts`, `src/main/video-editing/operator-authorization.ts`, `src/main/video-editing/operator-execution.ts`, `src/main/video-editing/operator-ipc.ts`, `src/main/video-editing/operator-verification.ts`, `src/main/video-editing/runtime-inspection.ts`, `src/main/video-editing/service.ts`, `src/main/video-editing/source-end-admission.ts`, `src/main/video-editing/store.ts`, `src/main/video-editing/ucv-validation.ts`, `src/main/video-editing/windows-build.ts`, `src/main/video-editing/windows-ucv-bridge.ts`, `src/main/video-editing/workflow-guards.ts`, `src/main/video-editing/workflow-state.ts`, `src/main/video-editing/workflow.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/main.ts`, `src/renderer/ucv-validation.ts`, `src/renderer/video-operator-controls.ts`, `src/shared/control-api.ts`, `src/shared/ucv-validation.ts`, `src/shared/video-editing.ts`, `test/control-api.test.ts`, `test/fixtures/davinci-adapter-contract.py`, `test/fixtures/video-capability-authentication.ts`, `test/renderer-ucv-validation.test.ts`, `test/renderer-video-native-execution.test.ts`, `test/renderer-video-operator-controls.test.ts`, `test/video-blocked-preparation-recovery.test.ts`, `test/video-capability-confirmation-receipt.test.ts`, `test/video-capability-operator-proof.test.ts`, `test/video-frame-contract.test.ts`, `test/video-legacy-prepared-recovery.test.ts`, `test/video-native-execution.test.ts`, `test/video-native-resolve-boundary.test.ts`, `test/video-operator-ipc.test.ts`, `test/video-operator-verification.test.ts`, `test/video-source-end-readmission.test.ts`, `test/video-ucv-validation-ipc.test.ts`, `test/video-ucv-validation-wiring.test.ts`, `test/video-ucv-validation.test.ts`, `test/video-windows-build.test.ts`, `test/video-windows-ucv-native.test.ts`, `test/windows-ucv-package-smoke.test.ts`, `test/windows-ucv-packaging.test.ts`, `test/workflow-adapter-diagnostic.test.ts`.

### 21. `44a1c88e9e9de390882c98cf4f95c8ee2b7657c5` — fix(ui): stabilize canonical verification gates

Classification: `TEST_HARDENING`. Purpose: UI gate stabilization.

Paths (7): `scripts/verify-composer-ui.cjs`, `scripts/verify-message-reactions.cjs`, `scripts/verify-plan-collapse.cjs`, `scripts/verify-ui.mjs`, `scripts/verify-workspace-terminal.cjs`, `src/renderer/timeline-scroll.ts`, `test/timeline-scroll.test.ts`.

### 22. `f11e54e846b0f65600bf7afd0f29f54d9bd39b68` — docs(kosmosyn): record S7.5 verified acceptance

Classification: `PUBLICATION_UNSUITABLE`. Purpose: Historical live acceptance log, condensed into normative contract.

Paths (20): `AGENTS.md`, `docs/kosmosyn-s7-5-video-editing.md`, `docs/windows-provider-metadata-diagnostic.md`, `docs/worklog-2026-10-08-kosmosyn-s7-5-installable-acceptance-candidate.md`, `docs/worklog-2026-10-08-kosmosyn-s7-5-media-runtime-operator-route.md`, `docs/worklog-2026-10-08-kosmosyn-s7-5-workflow.md`, `docs/worklog-2026-10-09-kosmosyn-s7-5-installer-acl-repair.md`, `docs/worklog-2026-10-09-kosmosyn-s7-5-session-ownership-repair.md`, `docs/worklog-2026-10-12-windows-provider-diagnostic-harness.md`, `docs/worklog-2026-10-12-windows11-ucv-devicenotpresent.md`, `docs/worklog-2026-10-12-windows11-ucv-implementation.md`, `docs/worklog-2026-10-13-legacy-capability-receipt-quarantine.md`, `docs/worklog-2026-10-13-s75-live-adapter-epoch-diagnostic.md`, `docs/worklog-2026-10-13-windows11-ucv-fixture-preflight-repair.md`, `docs/worklog-2026-10-13-windows11-ucv-packaging-repair.md`, `docs/worklog-2026-10-13-windows11-ucv-safe-validation-context.md`, `docs/worklog-2026-10-14-s75-blocked-preparation-recovery.md`, `docs/worklog-2026-10-15-s75-baseline-ui-gate-repair.md`, `docs/worklog-2026-10-15-s75-frame-end-contract-repair.md`, `docs/worklog-2026-10-15-s75-native-operator-minimal-implementation.md`.

### 23. `b8cc7a2787cc572acd36b3898f0deb6f5edfe7c6` — fix(mcp): harden exec ownership lifecycle

Classification: `MCP_SECURITY`. Purpose: Close anonymous exec sharing and retire deleted-session processes.

Paths (5): `src/main/codex/ownership.ts`, `src/main/mcp/tools-core.ts`, `src/main/session/store.ts`, `test/mcp.test.ts`, `test/workspace.test.ts`.

### 24. `537d0cfd1ca8ba1b13d1de0f3df0e26997e41c5a` — test(runtime): make async completion deterministic

Classification: `TEST_HARDENING`. Purpose: Make runtime completion test deterministic.

Paths (1): `test/codex-runtime-parity.test.ts`.

### 25. `45d19c937ed41d9eb1c798d391344bcc8f62f6c7` — test(protocol): make S4 expiry states deterministic

Classification: `PUBLICATION_UNSUITABLE`. Purpose: S4 expiry-state test stabilization; current main has no S4 subsystem, so the test has no owner on this branch.

Paths (1): `test/protocol/protocol-s4-canary.test.ts`.

## Change requirement matrix

`Equivalent` means the current public main already owns the stated behavior. `Conflict` identifies an existing owner or contract that required adaptation. All target paths are on the new integration branch; no old commit is transplanted as a commit.

| ID | Requirement | Local commit(s) | Local paths | Equivalent / conflict on main | Port / public | Target paths |
| --- | --- | --- | --- | --- | --- | --- |
| V01 | Bounded video request, artifacts, analysis, validation, plan and review | 9d54639d, b88f8908 | `src/main/video-editing/*`, `src/shared/video-editing.ts` | No / current config and MCP owners | Yes / yes | `src/main/video-editing/*`, `src/shared/video-editing.ts`, `src/main/mcp/video-editing-tool.ts` |
| V02 | Durable workflow state, exclusive transition/operation claims and receipts | b88f8908, a7145092, 8e5c8ed7 | `src/main/video-editing/store.ts`, `workflow*.ts`, `operator-execution.ts` | No / current durable writer differs | Yes / yes | `src/main/video-editing/*`, narrow `src/main/durable.ts` API |
| V03 | Logical half-open source ranges, validated source-end readmission | 7e033857, aaad0750, 3635ba8f, df9362a6 | `source-*.ts`, `workflow-*.ts` | No / none | Yes / yes | `src/main/video-editing/*`, `src/shared/video-editing.ts` |
| V04 | Exact capability admission and native readmission receipt | cffc6087, fe92b470, 3635ba8f | `capability*.ts`, `media-runtime*.ts` | No / current plugin guard | Yes / yes | `src/main/video-editing/*`, `src/main/plugins/{catalog,installer,manager}.ts` |
| V05 | Native operator confirmation bound to inspected job and fingerprint | 13a8dfe1, 8e5c8ed7 | `operator-ipc.ts`, `operator-authorization.ts` | No / current IPC trust boundary | Yes / yes | `src/main/video-editing/*`, `src/main/ipc.ts`, `src/preload/index.ts` |
| V06 | Distinct native execution principal; no MCP impersonation | 8e5c8ed7 | `operator-execution.ts`, `service.ts` | No / modern CallContext stays conversational | Yes / yes | `src/main/video-editing/*`, `src/main/plugins/manager.ts` |
| V07 | One-shot execution authorization and lifecycle revocation | 8e5c8ed7 | `operator-authorization.ts`, `operator-execution.ts` | No / current plugin installation lifetime | Yes / yes | `src/main/video-editing/*`, `src/main/plugins/manager.ts` |
| V08 | Single operation coordinator, claimed dispatch, observation-only recovery | a7145092, 8e5c8ed7 | `operator-execution.ts`, `store.ts` | No / current durable API | Yes / yes | `src/main/video-editing/*`, `src/main/durable.ts` |
| V09 | Windows UCV native verification, fixture and bounded IPC | 8bffaf90, 8e5c8ed7 | `native/windows-ucv/*`, `src/shared/ucv-validation.ts`, `scripts/windows-ucv*` | No / current native build flow | Yes / yes | same plus `electron.vite.config.ts`, `electron-builder.yml` |
| V10 | Curated Resolve adapter and runtime with strict policy | cffc6087, b2516c00, 024bdca2, 8e5c8ed7 | `davinci-adapter-source.ts`, `media-runtime*.ts` | No / current plugin manager and catalog changed | Yes / yes | `src/main/plugins/davinci*.ts`, `src/main/plugins/{catalog,installer,manager}.ts`, `src/main/video-editing/*` |
| V11 | One adapter-to-Resolve inclusive-end translation and 24 fps / 48-frame output | 8e5c8ed7 | `davinci-adapter-source.ts`, `test/video-frame-contract.test.ts` | No / none | Yes / yes | same; `test/video-frame-contract.test.ts` |
| V12 | Operator controls, media runtime status, native Execute/verification | fe92b470, 13a8dfe1, 8e5c8ed7 | `src/renderer/video-*.ts`, `src/renderer/index.html` | No / current UI has newer independent controls | Yes / yes | additive `src/renderer/*`, `src/preload/index.ts`, `src/main/ipc.ts` |
| V13 | Native build, packaged UCV and Resolve license metadata | a5e6f4e3, 8e5c8ed7 | `scripts/package.mjs`, `electron-builder.yml`, `scripts/windows-installer-acl.nsh` | Partial / newer packaging and installer messaging | Yes / yes, adapted | same plus UCV build and smoke scripts |
| M01 | Distinct unresolved requests never share exec ownership | b8cc7a27 | `src/main/codex/ownership.ts`, `test/mcp.test.ts` | No: red regression on current main / modern first-command rule | Yes / yes | `src/main/codex/ownership.ts`, `test/mcp.test.ts` |
| M02 | Deleting durable session retires its owned exec processes | b8cc7a27 | `src/main/codex/ownership.ts`, `src/main/session/store.ts`, `src/main/mcp/tools-core.ts` | No: missing retirement / current process owner | Yes / yes | same |
| T01 | Poll for semantic MCP state; deterministic async runtime completion | b8cc7a27, 537d0cfd | `test/mcp.test.ts`, `test/codex-runtime-parity.test.ts` | Partial / old fixed waits remain | Yes / yes | same |
| T02 | S4 protocol expiry tests | 45d19c93 | `test/protocol/protocol-s4-canary.test.ts` | No S4 protocol implementation exists on current main / orphan test | No / no pending owner decision | None; the test cannot execute against a nonexistent subsystem |

## Overlap decisions (all 34 exact changed-in-both paths)

The old base was `40c7ed8ab3a223c5dcc5cc1eb5106095473a0d4d`. Each row compares the accepted feature with fetched public main. `Adapt` means the new branch retains main's unrelated behavior and adds the S7.5 invariant at its existing boundary.

| Path | Current-main behavior | Accepted behavior | Resolution |
| --- | --- | --- | --- |
| `AGENTS.md` | Current public product/owner map | Older S7.5 owner map | Adapt the owner map only; preserve public instructions |
| `electron-builder.yml` | Current package resource map | UCV payload | Adapt resource map |
| `electron.vite.config.ts` | Current build pipeline | UCV native build | Adapt build hook |
| `scripts/verify-composer-ui.cjs` | Current UI fixture | S7.5 gate repair | Superseded; retain main |
| `scripts/verify-message-reactions.cjs` | Current UI fixture | S7.5 gate repair | Superseded; retain main |
| `scripts/verify-plan-collapse.cjs` | Current UI fixture | S7.5 gate repair | Superseded; retain main |
| `scripts/verify-ui.mjs` | Current UI runner | Added video check | Adapt only video check if still needed |
| `scripts/verify-workspace-terminal.cjs` | Current terminal fixture | Timing repair | Retain main where independently green; no broad timeout transplant |
| `scripts/windows-installer-acl.nsh` | Current failure explanation, premature init grant | Post-elevation grant | Adapt privilege boundary and retain failure explanation |
| `src/main/codex/ownership.ts` | First command for unidentified caller | Forbid shared null owner; retire deleted session | Adapt without losing first-command admission |
| `src/main/config.ts` | Current settings/defaults | Media runtime setting | Add bounded field only |
| `src/main/control-api.ts` | Current read projections | Video status reads | Add read-only projection |
| `src/main/durable.ts` | Current queued publication | Strict S7 ledger APIs | Add narrow strict APIs; preserve writer |
| `src/main/index.ts` | Current startup/shutdown | Media shutdown | Add media retirement at shutdown |
| `src/main/ipc.ts` | Current trusted-frame IPC | Native operator routes | Add fixed routes using current trust checks |
| `src/main/mcp/surfaces.ts` | Current Core surface | `video_editing` tool | Add declaration and scoped handler |
| `src/main/mcp/tools-core.ts` | Current exec command routing | Late start retirement | Fence process start after deletion |
| `src/main/mcp/tools-plugins.ts` | Current nested plugin exposure | Curated Resolve dispatch | Add guarded dispatch |
| `src/main/plugins/manager.ts` | Current plugin lifecycle | Curated Resolve adapter | Add guarded call through current manager |
| `src/main/session/store.ts` | Current durable session deletion | Exec retirement | Call existing ownership retirement at deletion |
| `src/preload/index.ts` | Current fixed API | Operator and UCV routes | Add fixed methods |
| `src/renderer/index.html` | Current Setup layout | Operator controls | Add controls in current Advanced section |
| `src/renderer/main.ts` | Current renderer initializers | Operator status/controls | Add additive initializer |
| `src/renderer/timeline-scroll.ts` | Current scroll anchoring | S7.5 UI gate repair | Retain main unless a direct regression proves gap |
| `src/shared/control-api.ts` | Current read schema | Video read schema | Extend fixed schema |
| `src/shared/types.ts` | Current config type | Media runtime type | Add bounded field |
| `test/codex-runtime-parity.test.ts` | Timing-sensitive completion | Semantic completion | Port test-only hardening |
| `test/control-api.test.ts` | Current control API tests | Video projection test | Cover through video focused tests; retain main fixture |
| `test/feature-parity.test.ts` | Current parity assertions | Video parity assertion | Cover through video focused tests; retain main fixture |
| `test/mcp.test.ts` | Current modern MCP cases | Security/lifecycle tests | Add focused regressions, keep main cases |
| `test/packaging.test.ts` | Current package assertions | UCV assertion | Cover with UCV package tests; keep main cases |
| `test/plugins-surface.test.ts` | Current plugin surface assertions | Video tool assertion | Cover with video/MCP focused tests; keep main cases |
| `test/timeline-scroll.test.ts` | Current scroll cases | UI gate repair | Retain main unless direct regression proves gap |
| `test/workspace.test.ts` | Current workspace fixture | Anonymous exec expectation | Correct caller identity in test; retain other cases |

## Publication hygiene

`KEEP_PUBLIC`: focused video/UCV/native tests, adapter, fixed operator surfaces, license metadata, concise normative S7.5 documentation, and the security regressions. `CONDENSE_PUBLIC`: accepted architecture and frame contract from the historical S7.5 acceptance worklog. `OMIT_PUBLIC`: installer scratch/abort capture package, the independent Windows provider diagnostic (the UCV fixture now owns its own import check), local diagnostic run reports, machine-specific live acceptance artifacts, temporary console output, private evidence, and generated `outputs/` / package trees. The accepted S4 test is omitted because public main has no S4 implementation to test. The pre-S7.5 38 commits, dirty notice file, dirty custom/main instruction and usage work, and local runtime ledger are excluded. No live Resolve acceptance was replayed.
