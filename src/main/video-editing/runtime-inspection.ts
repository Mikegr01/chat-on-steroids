import { ResolveEvidenceReader } from './inspection.js';
import { currentCall } from '../mcp/call-context.js';
import { dispatchRegisteredPluginTool } from '../mcp/tools-plugins.js';
import { pluginManager } from '../plugins/manager.js';
import { getConfig, effectiveCapabilities } from '../config.js';
import { resolvePath } from '../sandbox.js';
import type { ArtifactAccess } from './producers.js';
import { createAssetIngestor } from './workflow-ingestion.js';
import { DAVINCI_PUBLIC_TOOLS } from '../plugins/davinci.js';
import { VIDEO_ACCEPTANCE_GUARD_VERSION } from '../../shared/video-acceptance-target.js';
import type { PluginSnapshot } from '../../shared/plugins.js';

/** Explicit use under an already admitted caller; no startup, MCP exposure or ambient manager call. */
function curatedCall() {
  const parent=currentCall();if(!parent?.caller.sessionId)throw new Error('Exact admitted local session required');
  const owner=(name:string)=>{
    const snapshot=pluginManager.snapshot(),rows=snapshot.plugins.filter(row=>row.catalogId==='davinci-resolve'&&row.enabled&&row.status==='ready'&&row.tools.some(tool=>tool.name===name&&tool.enabled&&tool.published));
    if(rows.length!==1)throw new Error('Unique admitted curated Resolve tool required');
    return `${rows[0]!.id}:${snapshot.schemaRevision}`;
  };
  return async(name:string,args:Record<string,unknown>)=>{
    if(currentCall()!==parent)throw new Error('Resolve caller changed');const epoch=owner(name);
    const result=await dispatchRegisteredPluginTool(name,args);
    if(currentCall()!==parent||owner(name)!==epoch)throw new Error('Resolve owner changed');
    return resolveValue(result);
  };
}
function resolveValue(result: Awaited<ReturnType<typeof pluginManager.call>>) {
  const text=result.content.filter(block=>block.type==='text');
  if(text.length!==1||text[0]!.type!=='text'||Buffer.byteLength(text[0]!.text)>1024*1024)throw new Error('Resolve payload invalid');
  if(result.isError)throw new Error('Resolve adapter error: '+text[0]!.text);
  const value=JSON.parse(text[0]!.text) as unknown;
  return value;
}
export function createGuardedResolveReader() { return new ResolveEvidenceReader(curatedCall()); }
/** The only production translator: exact compiler args plus adapter-local project/snapshot guards.
 * Registered tool dispatch retains existing schema, permission and current plugin enforcement. */
export function createGuardedResolveDispatch() {
  return guardedResolveDispatch(curatedCall());
}
function guardedResolveDispatch(call: (name: string, args: Record<string,unknown>) => Promise<unknown>) {
  return async(operation:import('./execution.js').PreparedExecution['operations'][number],guard:{projectId:string;snapshotSha256:string})=>{
    if(operation.name!=='resolve_assemble_rough_cut')throw new Error('Unsupported execution operation');
    return call(operation.name,{...operation.arguments,guard_version:VIDEO_ACCEPTANCE_GUARD_VERSION,expected_project_unique_id:guard.projectId,expected_snapshot_sha256:guard.snapshotSha256});
  };
}

/** Paths returned by Resolve still need ordinary current approved-root/read permission. */
export function approvedVideoArtifactAccess(): ArtifactAccess {
  const parent = currentCall();
  if (!parent?.caller.sessionId) throw new Error('Exact admitted local session required');
  return artifactAccess(async () => { if (currentCall() !== parent) throw new Error('Artifact caller changed'); });
}
function artifactAccess(assertOwner: () => Promise<void>): ArtifactAccess {
  return async input => {
    await assertOwner();
    const config = getConfig();
    if (!effectiveCapabilities(config).read) throw new Error('Video artifact read capability unavailable');
    const resolved = await resolvePath(config.roots, input);
    await assertOwner();
    if (!effectiveCapabilities(getConfig()).read) throw new Error('Artifact access revoked');
    const current = await resolvePath(getConfig().roots, input);
    await assertOwner();
    if (!effectiveCapabilities(getConfig()).read) throw new Error('Artifact access revoked');
    if (current.real !== resolved.real) throw new Error('Artifact root/path changed');
    return current.real;
  };
}

/** Explicit workflow wiring shares the existing admitted read factories. No new tool or startup. */
export function createAdmittedAssetIngestor() {
  const parent = currentCall();
  const ingestor = createAssetIngestor({ access: approvedVideoArtifactAccess(), reader: createGuardedResolveReader() });
  return { async ingest(request: Parameters<typeof ingestor.ingest>[0]) {
    if (currentCall() !== parent || request.sessionId !== parent?.caller.sessionId) throw new Error('Work request session differs from admitted caller');
    return ingestor.ingest(request);
  } };
}
export function readAdmittedWorkflowCapabilities() {
  if (!currentCall()?.caller.sessionId) throw new Error('Exact admitted local session required');
  return curatedCapabilities();
}
function curatedCapabilities() {
  const rows = pluginManager.snapshot().plugins.filter(row => row.catalogId === 'davinci-resolve' && row.enabled && row.status === 'ready');
  if (rows.length !== 1) throw new Error('Unique curated Resolve owner required');
  const row = rows[0]!;
  const sourceEnd: 'inclusive' | 'exclusive' | 'unknown' = row.davinci?.sourceEnd ?? (row as any).sourceEnd ?? 'unknown';
  return { tools: row.tools.filter(tool => tool.enabled && tool.published && (DAVINCI_PUBLIC_TOOLS as readonly string[]).includes(tool.name))
    .map(tool => tool.name), sourceEnd, acceptance: 'unverified' as const };
}

/** Main-only video factory after native admission (or explicit read-only inspection). The caller
 * retains the exact lifecycle/scope guard; this port cannot supply conversational bookkeeping. */
export function createNativeResolveAccess(assertOwner: () => Promise<void>) {
  const adapter = readAdmittedWorkflowAdapterInfo();
  if (!adapter.ready) throw new Error('Unique curated Resolve owner required');
  const assertCurrent = async () => {
    await assertOwner();
    const config = getConfig();
    if (currentCall() || config.readOnly || !effectiveCapabilities(config).read || readAdmittedWorkflowAdapterInfo().epoch !== adapter.epoch)
      throw new Error('Native Resolve owner/permission changed');
  };
  const call = async (name: string, args: Record<string,unknown>) => {
    if (name !== 'resolve_inspect' && name !== 'resolve_assemble_rough_cut') throw new Error('Unsupported native Resolve operation');
    await assertCurrent();
    const result = await pluginManager.callCuratedResolve(name, args, adapter.epoch, assertCurrent);
    await assertCurrent();
    return resolveValue(result);
  };
  return { reader: new ResolveEvidenceReader(call), access: artifactAccess(assertCurrent),
    capabilities: curatedCapabilities(), epoch: adapter.epoch, call: guardedResolveDispatch(call) };
}

/** Monotonic existing plugin publication revision, not a second epoch owner. */
export function readAdmittedWorkflowEpoch() {
  if(!currentCall()?.caller.sessionId) throw new Error('Exact admitted local session required');
  const snapshot=pluginManager.snapshot(),rows=snapshot.plugins.filter(row=>row.catalogId==='davinci-resolve'&&row.enabled&&row.status==='ready');
  if(rows.length!==1) throw new Error('Unique curated Resolve owner required');
  return `${rows[0]!.id}:${snapshot.schemaRevision}`;
}

export interface WorkflowAdapterInfo {
  ready: boolean;
  sourceEnd: 'inclusive' | 'exclusive' | 'unknown';
  guardVersion: number;
  adapterVersion: string;
  epoch: string;
}

/**
 * Single authoritative workflow-adapter metadata reader shared by protected confirmation and
 * read-only diagnostics. The epoch intentionally includes PluginManager's global schemaRevision;
 * unrelated plugin publication changes can therefore invalidate an existing DaVinci admission.
 */
export function workflowAdapterInfoFromSnapshot(snapshot: PluginSnapshot): WorkflowAdapterInfo {
  const rows = snapshot.plugins.filter(row => row.catalogId === 'davinci-resolve' && row.enabled && row.status === 'ready');
  if (!Number.isSafeInteger(snapshot.schemaRevision) || snapshot.schemaRevision < 0) {
    return { ready: false, sourceEnd: 'unknown', guardVersion: 0, adapterVersion: '0.0.0', epoch: 'unknown' };
  }
  if (rows.length !== 1) {
    const anyResolve = snapshot.plugins.find(row => row.catalogId === 'davinci-resolve');
    return {
      ready: false,
      sourceEnd: (anyResolve?.davinci?.sourceEnd ?? 'unknown') as 'inclusive' | 'exclusive' | 'unknown',
      guardVersion: anyResolve?.davinci?.guardVersion ?? 0,
      adapterVersion: anyResolve?.version ?? '0.0.0',
      epoch: anyResolve ? `${anyResolve.id}:${snapshot.schemaRevision}` : 'unknown',
    };
  }
  const row = rows[0]!;
  return {
    ready: true,
    sourceEnd: (row.davinci?.sourceEnd ?? 'unknown') as 'inclusive' | 'exclusive' | 'unknown',
    guardVersion: row.davinci?.guardVersion ?? 0,
    adapterVersion: row.version,
    epoch: `${row.id}:${snapshot.schemaRevision}`,
  };
}

export function readAdmittedWorkflowAdapterInfo(): WorkflowAdapterInfo {
  return workflowAdapterInfoFromSnapshot(pluginManager.snapshot());
}
