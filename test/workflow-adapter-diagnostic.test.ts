import { describe, expect, it } from 'vitest';
import type { PluginSnapshot } from '../src/shared/plugins.js';
import { projectWorkflowAdapterDiagnostic } from '../src/main/control-api.js';
import { workflowAdapterInfoFromSnapshot } from '../src/main/video-editing/runtime-inspection.js';

function snapshot(schemaRevision = 18, overrides: Record<string, unknown> = {}): PluginSnapshot {
  return {
    catalog: [],
    schemaRevision,
    plugins: [{
      id: 'ea624669-8207-4138-9912-b5cd31a4bd0d',
      catalogId: 'davinci-resolve',
      name: 'DaVinci Resolve',
      version: '1.7.0',
      license: 'MIT',
      enabled: true,
      status: 'ready',
      installedAt: 1,
      tools: [],
      davinci: { sourceEnd: 'inclusive', guardVersion: 2 },
      ...overrides,
    }],
  } as unknown as PluginSnapshot;
}

describe('read-only live workflow-adapter diagnostic', () => {
  it('uses the same authoritative adapter reader as confirmation and exposes the exact epoch', () => {
    const authoritative = workflowAdapterInfoFromSnapshot(snapshot());
    const diagnostic = projectWorkflowAdapterDiagnostic(authoritative);

    expect(authoritative.epoch).toBe('ea624669-8207-4138-9912-b5cd31a4bd0d:18');
    expect(diagnostic).toEqual({
      provider: 'davinci-resolve',
      ready: true,
      version: '1.7.0',
      epoch: authoritative.epoch,
      sourceEnd: authoritative.sourceEnd,
      guardVersion: authoritative.guardVersion,
    });
  });

  it('reflects authoritative global schemaRevision changes without a second epoch algorithm', () => {
    const before = projectWorkflowAdapterDiagnostic(workflowAdapterInfoFromSnapshot(snapshot(18)));
    const after = projectWorkflowAdapterDiagnostic(workflowAdapterInfoFromSnapshot(snapshot(19)));

    expect(before.epoch).toBe('ea624669-8207-4138-9912-b5cd31a4bd0d:18');
    expect(after.epoch).toBe('ea624669-8207-4138-9912-b5cd31a4bd0d:19');
    expect(after.epoch).not.toBe(before.epoch);
  });

  it('fails closed when the provider is not ready', () => {
    const authoritative = workflowAdapterInfoFromSnapshot(snapshot(18, { status: 'error', davinci: undefined }));
    expect(projectWorkflowAdapterDiagnostic(authoritative)).toEqual({
      provider: null,
      ready: false,
      version: null,
      epoch: null,
      sourceEnd: 'unknown',
      guardVersion: null,
    });
  });

  it('fails closed when no unique ready DaVinci provider exists', () => {
    const duplicated = snapshot();
    duplicated.plugins.push({ ...duplicated.plugins[0]!, id: 'second-davinci-provider' });

    expect(projectWorkflowAdapterDiagnostic(workflowAdapterInfoFromSnapshot(duplicated))).toEqual({
      provider: null,
      ready: false,
      version: null,
      epoch: null,
      sourceEnd: 'unknown',
      guardVersion: null,
    });
  });

  it('fails closed when required confirmation metadata is unavailable', () => {
    const missingGuard = workflowAdapterInfoFromSnapshot(snapshot(18, { davinci: { sourceEnd: 'inclusive' } }));
    expect(projectWorkflowAdapterDiagnostic(missingGuard)).toEqual({
      provider: 'davinci-resolve',
      ready: false,
      version: '1.7.0',
      epoch: 'ea624669-8207-4138-9912-b5cd31a4bd0d:18',
      sourceEnd: 'inclusive',
      guardVersion: null,
    });
  });

  it('fails closed when the authoritative schema revision is unavailable', () => {
    const missingRevision = snapshot();
    (missingRevision as unknown as { schemaRevision: undefined }).schemaRevision = undefined;
    expect(projectWorkflowAdapterDiagnostic(workflowAdapterInfoFromSnapshot(missingRevision))).toEqual({
      provider: null,
      ready: false,
      version: null,
      epoch: null,
      sourceEnd: 'unknown',
      guardVersion: null,
    });
  });

  it('projects no job/session/conversation/proof/receipt or mutation authority from caller-shaped extras', () => {
    const authoritative = workflowAdapterInfoFromSnapshot(snapshot());
    const diagnostic = projectWorkflowAdapterDiagnostic({
      ...authoritative,
      jobId: 'job', sessionId: 'session', conversationId: 'conversation', hwnd: 123,
      proof: { forged: true }, receipt: { forged: true }, enableS7: true, mutateResolve: true,
    } as typeof authoritative);
    const text = JSON.stringify(diagnostic);

    for (const forbidden of ['jobId', 'sessionId', 'conversationId', 'hwnd', 'proof', 'receipt', 'enableS7', 'mutateResolve']) {
      expect(text).not.toContain(forbidden);
    }
  });
});
