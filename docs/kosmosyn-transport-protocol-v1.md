# Kosmosyn Transport Protocol V1 Architecture & Specification

## 1. Executive Summary & Purpose

Kosmosyn Transport Protocol V1 establishes a durable, typed, bidirectional command and event communication protocol between:
```
DESKTOP APP (Electron Main Authority)
        â†•
BROWSER TRANSPORT (Extension Background / Native Host)
        â†•
CHATGPT WEB SESSION (Content Script / DOM Session Engine)
```

The primary objective is transitioning from the legacy **action-driven** model (focus tab â†’ query DOM â†’ click button â†’ infer state â†’ guess retry) to a **state-driven** model (create durable command â†’ atomic outbox commit â†’ transport dispatch â†’ explicit session claim â†’ typed event stream â†’ observable commit verification â†’ safe reconciliation).

### Non-Goals
- **No Production Migration in This Phase**: Production traffic remains exclusively on the established production bridge (`src/main/bridge.ts`).
- **No Redesign of Frozen Workflows**: Phase 3 systems (Goal, Loop, Orchestrator, normal worker policy, ASK authorization, AUTO workers, worker/verifier model policies, Agents lifecycle, Orchestrator conductor state semantics) remain completely unchanged.
- **No UI Overhauls**: Renderer UI designs are out of scope.
- **No Heavy Distributed Frameworks**: No Kafka, Redis, Cadence, Temporal, or external database servers. This is a single-user desktop product; all persistence builds directly on atomic local NTFS/POSIX primitives.

---

## 2. Identity Architecture & Hierarchy

Every entity participating in the transport protocol has an explicit identity, lifetime scope, and canonical owner:

| Identifier | Format / Type | Scope | Canonical Owner | Description |
| :--- | :--- | :--- | :--- | :--- |
| **App Instance ID** | UUID string | `PROCESS_LOCAL` | Electron Main | Unique per app process run; invalidates old in-memory leases on restart. |
| **Desktop PID** | Integer | `PROCESS_LOCAL` | OS Kernel | Operating system process identifier. |
| **Protocol Version** | Literal `1` | `DURABLE` | Protocol Spec | Strict integer protocol version negotiated at handshake. |
| **Connection Epoch** | Opaque UUID | `EPHEMERAL` | Desktop Main | Fresh per accepted HELLO; equality with the current epoch is connection-incarnation authority. |
| **Connection Generation** | Integer | `EPHEMERAL` | Desktop Main | Legacy/diagnostic handshake correlation only. Once a connection epoch exists, numeric magnitude has no event-admission authority. |
| **Command ID** | `cmd_<uuid>` | `DURABLE` | Desktop Main | Unique opaque ID assigned to every command before persistence. |
| **Event ID** | `evt_<uuid>` | `EPHEMERAL` | Event Emitter | Unique opaque ID assigned to each emitted event; used for deduplication. |
| **Idempotency Key** | `idemp_<uuid>` / slug | `DURABLE` | Command Creator | Unique key representing semantic mutation intent; prevents duplicate execution. |
| **CoS Session ID** | Date slug / UUID | `DURABLE` | Session Store | Canonical Chat On Steroids local session entity. |
| **Conversation ID** | UUID `/c/<id>` | `CONVERSATION_LOCAL` | ChatGPT Web | ChatGPT web conversation identity. `null` only during initial composer bootstrap. |
| **Browser Instance ID** | UUID | `BROWSER_LOCAL` | Chrome Extension | Uniquely identifies a running Chrome browser session. |
| **Client Document ID** | `doc_<uuid>` | `EPHEMERAL` | Content Script | Unique per page/tab document instantiation; invalidated on navigation or reload. |
| **Emitter Epoch** | Opaque bounded string; content script uses Client Document ID | `EPHEMERAL` | Authorized emitter | Sequence-counter incarnation. Replacement is admitted only after command ownership/lease authority has accepted that emitter. |
| **Tab ID** | Integer | `BROWSER_LOCAL` | Chrome Tabs API | Chromium tab identifier. |
| **Turn ID** | `turn_<id>` / DOM attr | `SESSION_LOCAL` | ChatGPT DOM / Fiber | Identifies a single prompt-response turn in ChatGPT. |

### Rule on Identity Derivation
Command and event identities are **opaque UUIDs**. They are **never** derived from timestamps, prompt text content, or tab indices.

---

## 3. Command & Event Schemas

### 3.1 Command Envelope
```typescript
interface ProtocolCommand<TPayload> {
  protocolVersion: 1;
  commandId: string;
  commandType: 'SESSION_PROBE' | 'SEND_MESSAGE' | 'BIND_SESSION' | 'CANCEL_COMMAND';
  source: EndpointRole;
  target: EndpointRole;
  sessionId: string;
  conversationId: string | null;
  owner: string | null;
  generation: number; // legacy compatibility metadata; no connection-admission authority
  createdAt: number;
  expiresAt: number;
  idempotencyKey: string;
  payload: TPayload;
}
```

### 3.2 Command Payloads (Discriminated Union)
1. **`SESSION_PROBE`**:
   - `probeTabs`: boolean (default `true`)
   - `probeModels`: boolean (default `false`)
   - `targetConversationId`?: string | null
2. **`SEND_MESSAGE`**:
   - `text`: string (1 to 240,000 characters)
   - `targetConversationId`: string
   - `model`?: string | null
   - `reasoningEffort`?: string | null
   - `clientTurnId`?: string
   - `timeoutMs`: number (default 30,000ms)
3. **`BIND_SESSION`**:
   - `targetConversationId`: string
   - `sessionId`: string
   - `role`: `'prime' | 'worker'`
4. **`CANCEL_COMMAND`**:
   - `targetCommandId`: string
   - `reason`: string

### 3.3 Event Envelope
```typescript
interface ProtocolEvent<TPayload> {
  protocolVersion: 1;
  eventId: string;
  commandId: string;
  eventType: ProtocolEventType;
  source: EndpointRole;
  sessionId: string;
  conversationId: string | null;
  generation: number; // legacy/pre-handshake compatibility only
  connectionEpoch?: string;
  emitterEpoch?: string;
  sequence: number;
  occurredAt: number;
  payload: TPayload;
}
```

### 3.4 Key Event Types
- `COMMAND_PERSISTED`: Desktop has atomically committed command to disk.
- `COMMAND_DISPATCHED`: Transport accepted command for transmission.
- `COMMAND_CLAIMED`: Target document lease acquired (`clientDocumentId`, `tabId`).
- `MESSAGE_SUBMIT_STARTED`: Text injected, submit initiated.
- `MESSAGE_COMMITTED`: Matching user message observed in DOM with verification proof level.
- `TURN_STARTED`: ChatGPT started response generation (`Stop` button mounted).
- `TURN_COMPLETED`: Final response completed; terminal evidence collected.
- `COMMAND_COMPLETED`: Terminal protocol lifecycle success.
- `COMMAND_BLOCKED`: Precondition not met (wrong conversation, chat blocked, etc.).
- `COMMAND_FAILED`: Typed error occurred.

---

## 4. Command Lifecycle & State Machine

```mermaid
stateDiagram-v2
    [*] --> CREATED
    CREATED --> PERSISTED: Atomic Outbox Commit
    PERSISTED --> DISPATCHED: Wire Delivery
    PERSISTED --> BLOCKED: Precondition Failed
    PERSISTED --> CANCELED: User Canceled
    DISPATCHED --> CLAIMED: Target Document Leased
    DISPATCHED --> EXPIRED: Timeout Without Claim
    DISPATCHED --> AMBIGUOUS: Transport Dropped
    CLAIMED --> EXECUTING: Prompt Injected
    CLAIMED --> FAILED: Tab Closed / Reload
    EXECUTING --> COMMITTED: Observed in DOM
    EXECUTING --> AMBIGUOUS: Unconfirmed Mutation / Post-Submit Failure
    COMMITTED --> COMPLETED: Turn Finished & Verified
    COMMITTED --> COMMITTED: Post-Commit Workflow Failure (Mutation Truth Preserved)
    CANCELED --> COMMITTED: External DOM Commit Observed
    COMPLETED --> [*]
    FAILED --> [*]
    EXPIRED --> [*]
    CANCELED --> [*]
    AMBIGUOUS --> COMMITTED: Reconciled Found
    AMBIGUOUS --> FAILED: Reconciled Not Found
```

### State Semantics
- **`CREATED`**: Instantiated in memory. Proves only caller intent.
- **`PERSISTED`**: Written to disk outbox via atomic rename. Proves survivability across process crash.
- **`DISPATCHED`**: Transport layer accepted byte transmission. Proves network handover.
- **`CLAIMED`**: Specific browser document accepted exclusive lease. Proves target ownership.
- **`EXECUTING`**: Content script actively mutating DOM / injecting input. Post-submit failures during this state transition to `AMBIGUOUS`.
- **`COMMITTED`**: Irreversible side effect observed in ChatGPT conversation. Proves message is externalized. Overrides cancellation if commit is proven.
- **`COMPLETED`**: All post-conditions and terminal verification satisfied.
- **`AMBIGUOUS`**: Mutation dispatched, but success or failure cannot be definitively verified. **Auto-replay strictly forbidden.** Requires state reconciliation.

---

## 5. Commit Semantics & Ambiguity Handling

### 5.1 Commit Proof Levels for Mutations (`SEND_MESSAGE`)
1. **`STRONG_COMMIT`**:
   - Requires exactly one attributable new browser-native user-message identity that was absent from the pre-submit observed set.
   - The identity must belong to the command's target `/c/<conversationId>`; zero candidates, multiple plausible candidates, or a wrong conversation are `AMBIGUOUS`.
   - The durable command stores the native message identity and target conversation when commitment is accepted. The same native identity cannot commit two unrelated `SEND_MESSAGE` commands in one conversation.
   - Visible text is supporting evidence only. Identical visible messages remain distinct when their native IDs differ.
   - `MESSAGE_COMMITTED` is syntactically broad; `BrowserTransportService` is the semantic validation authority. A claimed `STRONG_COMMIT` becomes `COMMITTED` only for `SEND_MESSAGE` with a non-empty native ID, exactly one candidate, coherent conversation authorities, and no reuse by another command.
   - `candidateCount` is supporting browser/content-script evidence, not an independent authority; the native identity and correlation contract remain primary. The protocol POC adapter evidence is simulated until production transport migration.
   - A null command-envelope `conversationId` is allowed for `SEND_MESSAGE`; if non-null it must equal `payload.targetConversationId`. Event and commit-payload conversation IDs must also equal that target.
   - `matchedText` is optional transient supporting evidence. It is neither persisted in the durable command record nor logged by the service; durable commit truth stores identity/conversation, not prompt text.
   - Live qualification on 2026-10-03 observed three browser-visible user turn UUIDs. The two byte-identical `KOSMOSYN_NATIVE_ID_REPEAT` messages had different UUIDs. All three UUIDs survived a normal frontend rerender and full page reload unchanged. The current production `messageIdOf()` resolves the same UUID primitive through its browser-visible search/fiber fallback when `data-message-id` is absent.
   - No cookies, authorization headers, private backend endpoints, or authenticated network APIs are required for this identity proof.
2. **`WEAK_COMMIT`**:
   - Preliminary UI evidence: composer text cleared, send button clicked, or `Stop` button appeared, but without verified new user message ID in DOM.
   - **Safety Invariant (`UI_ACTION != COMMIT`)**: `WEAK_COMMIT` indicates progress only. It does **not** transition the command to `COMMITTED`.
3. **`AMBIGUOUS`**:
   - Send button was clicked or input dispatched, but before strong commit was verified:
     - The browser tab navigated, reloaded, or closed.
     - The desktop app or extension crashed.
     - The network connection dropped or timed out.
     - Composer remounted (`COMPOSER_STALE`) after submit was initiated.

### 5.2 Ambiguity Policy (Safety Invariant)
> **Under no circumstances does the protocol automatically replay a mutating command in `AMBIGUOUS` state.**
> A timeout is **never** a license to resend without proof. Re-querying session state and DOM history must occur before any retry decision.

### 5.3 Identity Roles
- `commandId`: durable protocol operation identity.
- `clientTurnId`: optional caller-side correlation identity; not commit proof.
- `nativeMessageId`: browser-native rendered user-message identity and the primary `SEND_MESSAGE` commit identity.
- No separate `submitAttemptId` is introduced because this milestone produced no evidence that it is required.

### 5.4 PROTOCOL_FINGERPRINT_V1
`PROTOCOL_FINGERPRINT_V1` covers this document plus every file under `src/shared/protocol/**`, `src/main/browser-transport/**`, and `test/protocol/**`. Normalize each relative path to forward slashes, calculate the raw-file SHA-256, sort lines as `<normalized-path>\\t<raw-file-sha256>`, terminate every manifest line with LF including the final line, UTF-8 encode that manifest, then SHA-256 the manifest bytes. This is the canonical candidate identity method; test counts are not architecture state.

---

## 6. Delivery, Idempotency & Deduplication

### 6.1 Transport Delivery: At-Least-Once
Network packets, IPC messages, and WebSocket frames can be delayed, dropped, or duplicated. The transport provides **at-least-once delivery**.

### 6.2 Processing Semantics: Idempotent
- **Commands**: Before creating or dispatching a command, the service queries the durable outbox for `idempotencyKey`.
  - If found with an **identical payload and parameters**: the existing record is returned without re-executing mutations.
  - If found with a **conflicting payload or parameters**: rejected immediately with `IDEMPOTENCY_CONFLICT`.
- **Event delivery identity**: `eventId` is ephemeral and identifies one delivery envelope, not an immutable external fact. Incoming events pass through a bounded `EventDeduplicator` (default 1,000 applied event IDs). Same-process redelivery is suppressed after successful processing.
- **Durable fact identity**: restart safety does not persist event UUIDs. It reuses the retained `DurableCommandRecord`. A strong `MESSAGE_COMMITTED` fact is `commandId + targetConversationId + nativeMessageId + MESSAGE_COMMITTED`. The same strong fact with a new `eventId` is a no-op reported as `FACT_ALREADY_APPLIED`. `COMMAND_COMPLETED` is lifecycle evidence, not an epoch-independent external fact.
- **Conflict policy**: once a command has a proven native message identity, a later strong commit claiming a different native identity is not a duplicate and is rejected as `CONFLICTING_DURABLE_FACT`; proven commit truth is never overwritten.
- **Write-failure policy**: delivery IDs are marked applied only after authoritative processing succeeds. Immutable commit/completion facts cross a synchronous durable commit barrier before their delivery ID is marked applied. Non-terminal progress transitions may be accepted into authoritative in-memory state and queue `writeDurableSoon()` before physical disk I/O completes; background retry then converges the durable projection. If a synchronous durable fact write fails, command state and store bookkeeping are rolled back, a newer safe snapshot supersedes the failed generation, and the event remains retryable.
- **Concurrency**: event handling is serialized at the service ingestion boundary so concurrent copies of one envelope, and concurrent different envelopes describing the same durable fact, converge to one applied fact without defining protocol sequence ordering.
- **Notifications**: transport duplicates and durable factual duplicates do not emit a second event/state notification. Ephemeral/progress observations that do not change the durable command record may still notify current-process listeners.
- **Retention**: no durable event journal is introduced. Durable fact authority lives only with the retained command record and disappears when that command is legitimately pruned; delivery dedupe remains bounded in memory.
- **Generations**: Distinct generation scopes protect against lagging events. Ephemeral transport reconnects must not discard legitimate commit events from an active conversation document.

### 6.3 Event Classifications

| Event type | Mutates durable command state | Durable fact identity required | Restart replay policy / stable identity |
| :--- | :---: | :---: | :--- |
| `COMMAND_PERSISTED` | No | No | Observation of desktop-owned state; no durable event dedupe. |
| `COMMAND_DISPATCHED` | No | No | Progress observation; durable command state is authoritative. |
| `COMMAND_CLAIMED` | Yes | No | Progress transition; reconcile against current durable lifecycle, not historical event UUIDs. |
| `SESSION_BOUND` | No | No | Ephemeral current-session observation; a post-restart bind may be new. |
| `SESSION_LOST` | No | No | Ephemeral current-session observation. |
| `TAB_ACQUIRED` | No | No | Ephemeral browser observation; never suppress a legitimate new acquisition from historical state. |
| `TAB_LOST` | No | No | Ephemeral browser observation. |
| `COMPOSER_ACQUIRED` | No | No | Ephemeral document/composer observation. |
| `COMPOSER_INVALIDATED` | No | No | Ephemeral document/composer observation. |
| `MESSAGE_SUBMIT_STARTED` | Yes | No | Progress transition to `EXECUTING`; durable lifecycle governs replay. |
| `MESSAGE_COMMITTED` | Yes | Yes | Durable external fact: command + target conversation + native message ID + semantic type. |
| `TURN_STARTED` | No | No | Progress observation; no historical suppression. |
| `TURN_COMPLETED` | No | No | Turn observation in V1; command completion remains separate durable authority. |
| `TURN_FAILED` | No | No | Turn observation in V1; does not itself define terminal command identity. |
| `COMMAND_BLOCKED` | Yes | Contextual | Retryable lifecycle state; identical delivery IDs dedupe in-process, later block facts may be meaningful. |
| `COMMAND_FAILED` | Yes | Contextual | Terminal command result; durable state prevents lifecycle regression, while failure payload semantics are not collapsed into a global event-type key. |
| `COMMAND_COMPLETED` | Yes | No | Current-emitter lifecycle evidence. It must pass connection/emitter freshness and lifecycle validation; a completed command still makes later completion a factual no-op. |

The protocol therefore targets **at-least-once delivery + idempotent factual processing + durable state convergence**. It does not claim exactly-once delivery.

### 6.4 Event Ordering Model

- **Sequence owner**: within one emitter epoch, the event emitter identified by `source`. Desktop does not synthesize or renumber peer sequences. V1 currently defines this receiver contract only; no production/PoC peer sequence allocator is implemented in the repository.
- **Sequence scope**: `(commandId, source, emitterEpoch)`. It is not global and it is not shared across `content-script` and `extension-background`; those roles are independent emitters and do not coordinate one counter.
- **Start / increment**: a producer starts at `1` for its source scope and increments by one for each newly emitted semantic event. `0` is invalid. At-least-once transport may duplicate an envelope without allocating a new sequence.
- **Reset**: no reset is valid while the same retained `(commandId, source, emitterEpoch)` remains authoritative. An authorized replacement emitter may begin at sequence 1; stale prior-emitter progress is rejected before ordering comparison.
- **Receiver high-water rule**: the durable command record stores the highest accepted sequence, semantic event type, and canonical semantic-payload identity independently for each source. A higher sequence is accepted even when it contains a gap because missing transport delivery cannot be inferred to be domain failure.
- **Same sequence**: same source + same sequence + same semantic type + same canonical semantic payload is an ordering replay. A different event type or different semantic payload is `SEQUENCE_COLLISION`. Durable facts are not discarded solely for such a collision; they continue to domain validation because sequence is not factual authority.
- **Lower sequence**: stale non-factual progress is rejected as `LOWER_SEQUENCE`. A valid strong `MESSAGE_COMMITTED` fact bypasses sequence suppression and is decided by immutable native-message identity instead. `COMMAND_COMPLETED` does not bypass epoch freshness.
- **Cross-command rule**: each command has independent source high-water marks. Interleaving such as `A1, B1, B2, A2` cannot interfere.
- **Cross-source rule**: there is no numeric comparison between `content-script` and `extension-background`. Handoffs are resolved by the command lifecycle and durable facts, not by pretending independent counters form one total order.
- **Durable-fact override**: sequence never overrides native-message identity conflicts, invalid lifecycle transitions, an already proven `COMMITTED` state, or durable factual identity. In particular, late `MESSAGE_SUBMIT_STARTED` cannot regress `COMMITTED`, and `COMMAND_COMPLETED` cannot manufacture commit truth.
- **Restart / write failure**: ordering high-water marks are part of the durable command record. They survive desktop restart. Advancing ordering authority crosses an immediate durable write barrier before the delivery ID is marked processed; if that write fails, both command mutation and ordering metadata roll back and the event remains retryable.
- **Rejected-event policy**: an event returned as rejected does not consume or advance the ordering slot. Events that are accepted as an ambiguity/failure observation may advance it even when their claimed domain evidence is insufficient; corrected durable facts still bypass ordering suppression and are re-evaluated by domain identity/lifecycle authority.
- **Generation boundary**: `source` is a bounded role enum and the durable record retains only one active emitter epoch/high-water slot per source, so state remains bounded. Ordering is proven inside one emitter epoch; replacement establishes a new epoch rather than comparing counters across incarnations.

---

## 7. Durability Architecture & Guarantee Boundaries

### Verdict: `EXISTING_DURABLE_REUSE = YES`
`src/main/durable.ts` provides:
- Write to temp file + atomic rename over target (NTFS & POSIX atomic guarantees).
- Per-named-state serialization queue (prevents concurrent write corruption).
- Immediate synchronous flush (`writeDurableNow`) for commit barriers.
- Debounced background flush (`writeDurableSoon`) for progress tracking.
- Corrupted file resilience (returns `null` on parse errors).

### Honest Durability Guarantee Boundary
- **Process Crash Consistency: YES**. Electron crashes, exceptions, or process terminations cannot leave half-written or corrupted files; atomic rename ensures the file points to either the old or new snapshot.
- **Hardware Power-Loss Durability: NO**. Neither `filehandle.sync()` nor `FlushFileBuffers` is called on the file or directory. Sudden power failure may lose page cache contents. Architecture claims must honestly state process-crash consistency rather than fsync-grade power-loss guarantees.

The protocol store is persisted under:
`userData/state/kosmosyn-transport-outbox.json`

---

## 8. Handshake & Capability Negotiation

When a transport channel connects:
1. **`HELLO`** (Extension â†’ Desktop):
   - `protocolVersion`: `1`
   - `extensionVersion`: string
   - `capabilities`: array of `ProtocolCapability`
   - `connectionGeneration`: number (peer compatibility/diagnostic input; it cannot choose or supersede the desktop epoch)
2. **`WELCOME`** (Desktop â†’ Extension):
   - `acceptedProtocolVersion`: `1`
   - `desktopInstanceId`: UUID
   - `negotiatedCapabilities`: supported subset
   - `reconcileRequested`: `true`
   - `connectionGeneration`: desktop compatibility correlation value
   - `connectionEpoch`: fresh opaque desktop-minted epoch
3. **`READY`** (Extension â†’ Desktop):
   - must echo the current `connectionGeneration` and exact `connectionEpoch`; an epoch-less or superseded READY cannot activate the connection.
4. **`REJECT`** (Desktop â†’ Extension):
   - Dispatched immediately if `protocolVersion !== 1`.
   - Reason: `'PROTOCOL_MISMATCH'`.

---

## 9. Transport Comparison: Loopback HTTP vs Chrome Native Messaging

| Criterion | Current Loopback HTTP Bridge | Chrome Native Messaging | Recommended Direction |
| :--- | :--- | :--- | :--- |
| **Channel Mechanism** | HTTP/1.1 REST over `127.0.0.1:8765-8769` | `stdio` pipe managed by Chrome | **Hybrid via Transport Abstraction** |
| **Setup & Registry** | Zero registry modification required | Requires Windows Registry key + Host Manifest JSON | HTTP for dev/current; Native Messaging optional |
| **Extension ID Dependency**| Agnostic; validates `chrome-extension://` origin | Requires hardcoded Extension ID in manifest | HTTP is easier for unpacked dev; NM for release |
| **Persistent Connection** | HTTP polling / SSE / wake trigger | Native pipe open; keeps MV3 worker alive | Native Messaging eliminates MV3 30s sleep |
| **Firewall / Port Conflicts** | Sensitive to port collisions & local security rules | Immune to firewall / port collision issues | Native Messaging superior for strict IT environments |
| **Message Limits** | Bounded by HTTP body limit (default 2-4MB) | 1MB message size limit in Chrome | Protocol chunks large inputs |
| **Performance / Latency** | ~2-5ms loopback roundtrip | < 1ms pipe roundtrip | Both negligible compared to ChatGPT DOM |
| **Migration Risk** | Zero; already working in production | High; requires host installer & registry wiring | Keep HTTP production bridge; use adapter for NM |

### Rust Native Host Evaluation
- **`RUST_NATIVE_HOST_VALUE = MEDIUM`**
- **`RECOMMENDED_NOW = NO`**
- **Rationale**: While a Rust binary (`cos-native-host.exe`) offers a tiny footprint (~2MB) and safe I/O framing, introducing a Rust toolchain into the build pipeline now would add packaging complexity without improving protocol correctness. Node/Electron already handles native IPC cleanly. The protocol state machine is strictly transport-independent via `TransportAdapter`.

---

## 10. Proof of Concept & Fault Injection Verification

An isolated, transport-independent POC was implemented in `src/main/browser-transport/` and validated by the focused protocol suite in `test/protocol/`:

1. **`test/protocol/protocol-schemas.test.ts`**:
   - Validates commands, events, handshake, capabilities, and error codes.
2. **`test/protocol/protocol-lifecycle.test.ts`**:
   - Validates state transitions, idempotency deduplication, legacy pre-handshake generation rejection, and post-commit cancellation refusal.
3. **`test/protocol/protocol-durability.test.ts`**:
   - Validates disk outbox persistence via `durable.ts` and restart recovery.
4. **`test/protocol/protocol-fault-injection.test.ts`**:
   - Covers deterministic transport and lifecycle failure scenarios including:
     1. Desktop dies after persist but before dispatch â†’ safe outbox resume.
     2. Same command delivered twice â†’ idempotency key dedupes.
     3. Extension dies before ACK â†’ mutating command becomes AMBIGUOUS.
     4. Browser reloads mid-command â†’ transitions to AMBIGUOUS.
     5. Composer remounts before any possible submit: COMPOSER_STALE; safe retry may be allowed. After submit may have occurred: AMBIGUOUS; no automatic replay.
     6. Commit verified but completion event lost â†’ stays COMMITTED, no double-send.
     7. Duplicate event delivery â†’ EventDeduplicator absorbs safely.
     8. Pre-handshake stale numeric generation â†’ rejected with STALE_GENERATION; after epoch negotiation, opaque epoch equality is authoritative.
     9. Wrong conversation targeted â†’ marked BLOCKED / FAILED.
     10. Tab closed during operation â†’ marked FAILED (TAB_CLOSED).
     11. Incompatible protocol version â†’ handshake rejects with PROTOCOL_MISMATCH.
     12. Command timeout/expiry â†’ lease expired, claim refused.
     13. Cancel before commit â†’ successfully transitions to CANCELED.
     14. Cancel after commit â†’ refused with COMMIT_ALREADY_OCCURRED.
     15. Transport disconnect/reconnect â†’ outbox cleanly redelivers without data loss.
5. **`test/protocol/protocol-ordering.test.ts`**:
   - Proves per-command and per-source isolation, forward-gap acceptance, late-lower rejection, same-sequence type/payload collision handling, durable-fact override, completion-before-commit rejection, restart persistence, and ordering-write rollback.
## Generation separation

Protocol V1 treats lifetime identity and ordering as separate concerns:

- `connectionEpoch` is an opaque desktop-minted identity for exactly one negotiated transport incarnation. READY and non-durable event admission require equality with the active epoch; epochs are never compared numerically.
- Epoch fields remain optional in the wire schema only for legacy/pre-handshake compatibility and epoch-independent strong commit reconciliation. Once an epoch-aware connection is negotiated, non-durable/current-lifecycle traffic without `connectionEpoch` or `emitterEpoch` is rejected rather than downgraded to legacy authority.
- `emitterEpoch` identifies one sequence-counter owner incarnation. For content-script events it is the document identity established by `COMMAND_CLAIMED`. A claim can establish/replace emitter authority only when the same document already holds a valid command ownership lease; an event cannot bypass `claimCommand()`. A replacement document may restart its sequence at 1; progress from the superseded document is stale.
- `sequence` is ordered only inside one command/source/emitter epoch. It has no meaning across emitter epochs.
- strong external mutation facts are reconciled by durable domain identity (`commandId`, target `conversationId`, `nativeMessageId`) even when reported by a superseded emitter. Rediscovery of the same fact remains `FACT_ALREADY_APPLIED`.
- `COMMAND_COMPLETED` is not equivalent to strong external mutation proof. It must come from the current connection/emitter and pass lifecycle validation; stale completion cannot terminate replacement work.
- durable command intent is not bound to a transport epoch. The legacy numeric `generation` command field remains wire-compatible but is emitted as `0` and carries no connection-admission authority.
- The event `generation` field is retained for legacy/pre-handshake compatibility. Once `connectionEpoch` exists, its numeric value has no freshness or supersession authority.

The service retains only the active emitter epoch and its high-water ordering slot per command/source. It does not keep an unbounded connection or epoch journal.
