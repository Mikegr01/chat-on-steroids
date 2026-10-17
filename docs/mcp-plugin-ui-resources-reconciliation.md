# MCP plugin UI resources reconciliation

## Reconstruction before production edits

Authoritative base: `082dc5c7cc931a33005ae4d21dc3ec94d455e0e2`, verified after fetching origin.
New branch: `fix/mcp-plugin-ui-resources-reconciled`. Initial HEAD equals the base,
working tree clean, staged paths zero. Existing worktrees were inventoried and preserved.

Historical sources: `repair/mcp-plugins-404` at
`6afd344c044fff55f2a054675027ef6d6f0de6ae` and `integration/mcp-plugins-404` at
`83d6cc0ededd46c9a79eb9a8786e29645ebac976`. Their trees are identical. Each tip is
the isolated repair; the other 19 unique commits are excluded. Historical paths:
`src/main/plugins/manager.ts`, `src/main/mcp/tools-plugins.ts`,
`src/main/mcp/server.ts`, `test/plugins-manager.test.ts`, `test/plugins-surface.test.ts`.

Historical behavior: derive resource owners from exposed tool metadata, serve list/read,
reuse manager client custody, enforce 16 MiB and redact responses. Tests covered metadata,
read, disable, restart, uninstall, duplicate URIs and upstream failure. Assumptions needing
replacement: permissive arbitrary URI strings, flat legacy metadata alias, active-only
collision claims, URL normalization during registration, cached SDK reads and no final
owner/catalog check. Optional HTTP method logging is unrelated and excluded. No legacy
orchestrator dependencies are needed.

## Current-main requirement matrix

| Requirement | Before repair | Needed behavior |
| --- | --- | --- |
| 01 discovery | MISSING | Bounded UI URIs from admitted tool metadata |
| 02 metadata | PARTIALLY_IMPLEMENTED | Tool metadata preserved; interpret two supported keys |
| 03 list | MISSING | Dynamic deterministic Plugins-only list |
| 04 read | MISSING | Exact admitted owner and live client |
| 05 ownership | MISSING | One derived exposure projection |
| 06 collisions | PARTIALLY_IMPLEMENTED | Reuse retained tool-claim semantics for resource claims |
| 07 unknown URI | PARTIALLY_IMPLEMENTED | Currently no resource handlers; retain refusal after enabling |
| 08 lifecycle | PARTIALLY_IMPLEMENTED | Existing manager lifecycle owns resource retirement too |
| 09 protocol/security | PARTIALLY_IMPLEMENTED | SDK validation, size bounds, redaction and no arbitrary fetch |

## Authority and security decisions

Resource discovery and URI ownership: `pluginExposure`, projected by `PluginManager`.
Lifecycle and read ownership: `PluginManager`, using its existing records, queues and live clients.
The MCP registrar adapts the manager's current list/read; no independent registry or lifecycle.

Only exact canonical `ui://` identifiers without URL credentials or whitespace are candidates.
Support `_meta['openai/outputTemplate']` and `_meta.ui.resourceUri`.
Evidence: [MCP Apps overview](https://apps.extensions.modelcontextprotocol.io/api/documents/Overview.html)
and [OpenAI reference](https://developers.openai.com/plugins/reference).
Flat `_meta['ui/resourceUri']` is excluded from this reconciliation.

Retained catalogs reserve conflicting URIs even when a plugin/tool is disabled or errored;
uninstall or changed discovery can release claims. Only admitted tools on a ready live client
can expose/read a uniquely owned resource. List order is URI code-unit order. The required
resource name is its exact authoritative URI; no invented MIME, description or metadata.
Actual content MIME and metadata come from the upstream read response.
Two candidates per admitted tool and the existing 256-tool / 250,000-schema-byte ceiling
bound publication to at most 512 resource identifiers; retained claims also remain under
the existing per-installation discovery bounds and 24-installation limit.

Host resource discovery/read uses the existing tokenized Plugins endpoint and plugin
admission, separate from model tool execution and its inbox/recording side effects. It cannot
invoke tools or read local/network paths. Read-only also refuses plugin resources. Core and
Desktop gain no resource handlers. No bridge identity, S7.5 or shared HTTP routing changes.

Reads bypass SDK caching, validate content URIs, enforce the existing 16 MiB result bound,
redact authored text/metadata without corrupting blobs, and revalidate client/catalog custody
after the await. Upstream errors keep protocol codes but lose private error data. Refresh
temporarily withholds resources; no retired result may publish after lifecycle replacement.

## Verification

Deterministic RED on unchanged production: the focused protocol reproduction failed all five
selected cases (both metadata forms, empty list/unknown URI, collisions and lifecycle).
Initialize omitted resources capability and resource methods had no successful result.
The initial broad RED run was stopped when its held-response tests necessarily waited for
unimplemented reads; no production edits preceded the completed focused RED reproduction.

Final focused GREEN: 13 suites, 405 passed / 7 skipped. Includes plugin manager, surface, exposure,
OAuth, all 38 new resource cases, MCP dispatch/inbound/inflight/declarations, identity isolation,
DaVinci and native video execution/Resolve boundaries. The ten final collision/concurrency tests
also passed three additional consecutive runs (30/30). One unsupported Vitest `--repeat`
invocation started no tests; repetition used three normal bounded invocations instead.

Adversarial review: collision claims (including disabled claimants), unknown/arbitrary file,
network and filesystem reads, duplicate tool ownership, resource/schema budgets, malformed
metadata/contents, foreign content URIs, oversized framing and decoded results, credential
text/URI/error metadata, opaque blobs, authorization failure, synchronous disable/uninstall,
restart, in-flight tool revocation, read-only changes and held refresh publication all pass.
An initial error-code defect for disconnect/framing failures was repaired before focused GREEN:
owner unavailability is an explicit internal error rather than resource-not-found.
A further MIME regression reproduced broad redaction corrupting `text/html;profile=mcp-app`
when a credential matched `text/html`. Final redaction preserves protocol MIME/blob fields;
the regression is GREEN. Shutdown and same-URI catalog refresh have held-response coverage too.
No unresolved HIGH/CRITICAL finding remains in this review.

Environment: current process and input desktop both verified as `WinSta0\\Default`, Windows
session 1, non-elevated. A fresh reproducible dependency install was confined to this worktree;
renderer build artifacts must be prepared before the ordered UI gate.
The initial typecheck and UI gate passed (53/53 UI checks). Following the MIME refinement,
focused/adversarial checks passed again and final-code renderer artifacts were prepared.

## Earlier stopped gate

Final-code `npm run typecheck`: PASS.
Final-code `npm run verify:ui`: FAIL, 52/53 checks passed.
`scripts/verify-workspace-terminal.cjs` timed out awaiting the output marker
`PROOF_persisted_child`; its captured error list was empty. This evidence does not establish
the cause. The earlier UI pass preceded the MIME refinement and does not supersede this failure.

The required stop boundary was honored: no repair, diagnostic rerun, subsequent ordered build,
canonical whitespace gate, full `npm run verify`, publication scan or commit followed the failure.
Preparatory builds passed; they are not a completed final ordered build gate.
The full canonical command was invoked zero times.

That attempt stopped uncommitted at the authoritative base. Subsequent independent baseline
reproduction excluded the resource candidate from the terminal fixture's runtime graph.
The explicit closure continuation permits only that exact baseline failure as an exception;
it does not authorize a terminal repair or acceptance of any different failure.

## Final closure — 2026-10-17

The branch and starting HEAD matched the authoritative base; all six file hashes matched the
preserved report before verification. Remote main remained unchanged before commit preparation.
Production, tests and the agent map stayed byte-for-byte preserved through all gates; only this
worklog was then updated to record the completed validation.

The six paths are `AGENTS.md`, `src/main/mcp/tools-plugins.ts`,
`src/main/plugins/exposure.ts`, `src/main/plugins/manager.ts`,
`test/plugins-resources.test.ts` and this worklog. No shared server, terminal, dependency,
bridge identity or S7.5 production code changed. The existing server routing is sufficient;
resource capability and protocol handlers belong to the Plugins registrar.

The established 13-suite focused set passed once: 405 passed / 7 skipped, including all 38
resource adversarial cases, identity isolation, Plugins endpoint profile isolation and the
DaVinci/native video execution/Resolve boundaries. Bridge-port and connection regression suites
passed 50/50, including duplicate tunnel ownership. The prior 30/30 collision/concurrency
repetitions remain accepted evidence; no additional repetition campaign was run.

Ordered gates: `npm run typecheck` PASS; `npm run build` PASS (existing Vite warnings);
`git diff --check` PASS. Exactly one `npm run verify:ui` passed 53/53, including workspace
terminal, without configured retries or skips. Exactly one full `npm run verify` exited 0:
native pre-gate 6/6; main stage 400 files passed / 7 skipped, 9,654 tests passed / 51 skipped;
serial Desktop/MCP shutdown stage 2 files and 28 tests passed. These are stage counts and
include overlapping native coverage. Both runs used interactive WinSta0/Default and raw
cmd.exe redirection. No baseline exception was needed by either run.

Baseline terminal debt remains unresolved: BrowserWindow Return input can occasionally fail
before Chromium DOM keydown despite a live/focused xterm. The exact authoritative base
reproduced this failure independently; candidate causality is excluded. The first missing
boundary is Electron to Chromium DOM keydown. Root cause is unproven and no terminal repair
is included. This passing UI run does not invalidate the documented intermittent defect.

Acceptance classification: `A = MCP_PLUGIN_RESOURCES_READY_FOR_INDEPENDENT_REVIEW`.
Closure is limited to one focused resource reconciliation commit and publication scan,
followed by independent review. Push=NO; PR=NO; merge=NO. This is source/test/build evidence;
installed payload and live provider resource rendering are not claimed.
