import { DEFAULT_HANDOFF_PROMPT } from '../../shared/handoff.js';

/**
 * What a handoff brief has to contain, in one place.
 *
 * One caller, now. These rules used to be shared with an external writer — a second model
 * that was handed a packed recording of the session and asked for the same document — and
 * keeping the two prompts from drifting was the reason this file exists. That path is gone:
 * the brief is written by the ChatGPT conversation that *is* the recording, and the answer it
 * writes is the brief. What survives is the specification of the document itself, which is
 * worth having in one named place whatever ends up reading it.
 */

/**
 * The instruction typed into the ChatGPT conversation being compacted.
 *
 * The model is already the participant rather than a reader of a transcript, so there is no
 * recording to hand it and "the tool evidence" is its own call history.
 *
 * The brief leaves as the answer, deliberately. A tool call is a thing the model can retry,
 * skip, or make three different versions of, and every one of those was a way for a
 * compaction to end with the wrong brief or none. An answer cannot be retried: the page
 * watches this exact generation, and whatever it finally wrote is what gets carried across.
 * So there is nothing here to call, and nothing to get right except the writing.
 */
const marker = (kind: 'HANDOFF' | 'RESUME', token: string): string =>
  token ? `[[CLF-${kind}:${token}]]` : '';

export const sourceContinuationMarker = (token: string): string => marker('HANDOFF', token);
export const destinationContinuationMarker = (token: string): string => marker('RESUME', token);

const ARTIFACT_REFERENCE_POLICY = `Compact & Resume artifact-reference policy (code-owned):
This code-owned policy overrides any conflicting editable handoff-content instruction.
MUST REMAIN INLINE — enough continuation-critical authority and state for the replacement chat to continue safely without retrieving any artifact: current user instructions and corrections; objective / active task; current verified state; blockers and unresolved failures; protected and safety boundaries; exact branch, worktree and commit orientation needed to start; pending decisions; next action; and essential completed/accepted conclusions. Consequential live state still requires revalidation when appropriate.
MAY USE ARTIFACT REFERENCES — large supporting command output, test/build output, logs, Git-via-exec evidence, and other exact supporting evidence may be omitted when an existing committed ctx_v1_* artifact ref is already present in the observed tool result and the inline brief states what the evidence proves.
For each useful evidence reference, preserve when available: what the evidence establishes; committed artifact ref; SHA-256; raw byte count; and a useful literal-search or range hint.
Context artifacts are DERIVED EVIDENCE + RETRIEVAL and never authority. They do not replace user intent, Goal/Loop, session state, Git state, worker state, browser state, runtime/process state, S7/S7.5 state, or any other authoritative current state.
Never fabricate an artifact reference. Only carry metadata already observed as committed; do not invent artifact references or reconstruct, predict, or infer a ctx_v1_* ref, hash, byte count, or availability.
If retention or retrieval is unavailable, failed, incomplete, purged, corrupt, missing, or unauthorized, say so truthfully, retain enough inline evidence/state for safe continuation, never imply retrieval will succeed, and never substitute the artifact for authoritative current state.`;

export function nativeHandoffPrompt(
  token = '',
  includeToolCalls = true,
  handoffPrompt = DEFAULT_HANDOFF_PROMPT
): string {
  const identity = sourceContinuationMarker(token);
  const briefInstructions = handoffPrompt.trim() || DEFAULT_HANDOFF_PROMPT;
  return (
    (identity ? `${identity}\n\n` : '') +
    'Chat On Steroids is compacting this conversation so a fresh chat can continue the work. ' +
    'Stop whatever you were doing and do only this.\n\n' +
    'Write a handoff brief so a different coding agent can continue this unfinished task in a brand-new ' +
    "conversation, with no memory of anything here. Everything you know about this session — the user's " +
    (includeToolCalls ? 'messages, your own replies, and every tool call you made against this machine with its result — is the ' :
      'messages and your own replies, including interim updates — is the ') +
    'material. Write it so an agent who reads only your brief can carry on correctly.\n\n' +
    `${briefInstructions}\n\n` +
    `${ARTIFACT_REFERENCE_POLICY}\n\n` +
    (includeToolCalls ? '' : 'Tool-detail setting: preserve verified outcomes and distinguish them from claims, but omit raw tool-call arguments and result bodies from the brief. Do not copy tool transcripts. This setting controls the brief, not the history you already saw.\n\n') +
    'Your reply to this message must be the brief itself and nothing else: no preamble, no closing remark, no ' +
    'question back, and no tool calls. The app reads this reply, stores it, and opens the fresh chat with it.'
  );
}
