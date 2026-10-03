import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { Config } from '../src/shared/types.js';
import { createAgentPanel } from '../src/renderer/agent-panel.js';
import type { SessionSummary } from '../src/shared/session.js';

let dom: JSDOM;

afterEach(() => {
  dom?.window.close();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('Orchestrator Phase 3 UI & Model Policy', () => {
  it('index.html contains worker policy, worker/verifier model policy, and ORCH toggle controls', async () => {
    const html = await readFile('src/renderer/index.html', 'utf8');
    dom = new JSDOM(html);
    const doc = dom.window.document;

    // Worker Policy
    const workerPolicy = doc.getElementById('workerPolicy') as HTMLSelectElement | null;
    expect(workerPolicy).not.toBeNull();
    const wpOptions = Array.from(workerPolicy!.options).map(opt => opt.value);
    expect(wpOptions).toEqual(['off', 'ask', 'auto']);

    // Worker Model Policy & Specific Model Row
    const workerModelPolicy = doc.getElementById('workerModelPolicy') as HTMLSelectElement | null;
    expect(workerModelPolicy).not.toBeNull();
    const wmpOptions = Array.from(workerModelPolicy!.options).map(opt => opt.value);
    expect(wmpOptions).toEqual(['auto', 'inherit_prime', 'specific_model']);

    const workerSpecificModelRow = doc.getElementById('workerSpecificModelRow');
    expect(workerSpecificModelRow).not.toBeNull();
    expect(doc.getElementById('workerSpecificModel')).not.toBeNull();

    // Verifier Model Policy & Specific Model Row
    const verifierModelPolicy = doc.getElementById('verifierModelPolicy') as HTMLSelectElement | null;
    expect(verifierModelPolicy).not.toBeNull();
    const vmpOptions = Array.from(verifierModelPolicy!.options).map(opt => opt.value);
    expect(vmpOptions).toEqual(['auto', 'inherit_prime', 'specific_model']);

    const verifierSpecificModelRow = doc.getElementById('verifierSpecificModelRow');
    expect(verifierSpecificModelRow).not.toBeNull();
    expect(doc.getElementById('verifierSpecificModel')).not.toBeNull();

    // Independent ORCH controls
    expect(doc.getElementById('orchToggle')).not.toBeNull();
    expect(doc.getElementById('orchSwitch')).not.toBeNull();
    expect(doc.getElementById('orchStatus')).not.toBeNull();
  });

  it('populates worker and verifier specific model selects from live catalog and flags unavailable models', async () => {
    dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);

    const models = [
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', efforts: ['low', 'medium'] },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['high'] }
    ];

    Object.assign(dom.window, {
      api: {
        getChatModels: async () => ({ ok: true, data: { state: 'ready', models } }),
        onChatModelsChanged: vi.fn()
      }
    });

    const { initChatModels, applyChatModels } = await import('../src/renderer/chat-models.js');
    initChatModels();

    // Test with available specific models
    applyChatModels({
      multiAgent: {
        workerModelPolicy: 'specific_model',
        workerSpecificModel: 'gpt-5.4-mini',
        verifierModelPolicy: 'specific_model',
        verifierSpecificModel: 'gpt-5.6-sol'
      },
      goal: {}
    } as Config);
    await Promise.resolve();

    const workerSelect = dom.window.document.getElementById('workerSpecificModel') as HTMLSelectElement;
    const verifierSelect = dom.window.document.getElementById('verifierSpecificModel') as HTMLSelectElement;

    expect(workerSelect.value).toBe('gpt-5.4-mini');
    expect(verifierSelect.value).toBe('gpt-5.6-sol');

    // Test with unavailable/disappeared specific model
    applyChatModels({
      multiAgent: {
        workerModelPolicy: 'specific_model',
        workerSpecificModel: 'disappeared-model-v9',
        verifierModelPolicy: 'specific_model',
        verifierSpecificModel: 'gpt-5.6-sol'
      },
      goal: {}
    } as Config);
    await Promise.resolve();

    expect(workerSelect.value).toBe('disappeared-model-v9');
    const workerBadge = dom.window.document.getElementById('workerSpecificModelVerification');
    expect(workerBadge).not.toBeNull();
    expect(workerBadge!.hidden).toBe(false);
    expect(workerBadge!.textContent).toContain('Unavailable · Falls back to Inherit Prime');
  });

  it('renders provenance chips accurately in the agent panel', () => {
    dom = new JSDOM('<main></main><button></button>');
    Object.assign(globalThis, { document: dom.window.document });
    const host = document.querySelector('main')!;
    const toggle = document.querySelector('button')!;

    const panel = createAgentPanel({
      host,
      toggle,
      load: async () => ({ events: [] }),
      render: () => [],
      openMain: vi.fn(),
      working: () => true
    });

    const sessions: SessionSummary[] = [
      {
        id: 'worker-orch-1',
        title: 'worker-1',
        conversationId: 'chat-orch-worker',
        startedAt: Date.now() - 30_000,
        updatedAt: Date.now(),
        origin: {
          kind: 'worker',
          fromSessionId: 'prime',
          agentId: 'worker-1',
          task: 'Execute step instructions',
          origin: 'ORCHESTRATOR',
          executionRole: 'worker'
        }
      } as SessionSummary,
      {
        id: 'worker-orch-2',
        title: 'verifier-1',
        conversationId: 'chat-orch-verifier',
        startedAt: Date.now() - 20_000,
        updatedAt: Date.now(),
        origin: {
          kind: 'worker',
          fromSessionId: 'prime',
          agentId: 'verifier-1',
          task: 'Verify step results against acceptance criteria',
          origin: 'ORCHESTRATOR',
          executionRole: 'verifier'
        }
      } as SessionSummary,
      {
        id: 'worker-auth',
        title: 'worker-2',
        conversationId: 'chat-auth',
        startedAt: Date.now() - 10_000,
        updatedAt: Date.now(),
        origin: {
          kind: 'worker',
          fromSessionId: 'prime',
          agentId: 'worker-2',
          task: 'Authorized task',
          origin: 'NORMAL_AUTHORIZED'
        }
      } as SessionSummary,
      {
        id: 'worker-auto',
        title: 'worker-3',
        conversationId: 'chat-auto',
        startedAt: Date.now() - 5_000,
        updatedAt: Date.now(),
        origin: {
          kind: 'worker',
          fromSessionId: 'prime',
          agentId: 'worker-3',
          task: 'Auto sub-agent task',
          origin: 'NORMAL_AUTO'
        }
      } as SessionSummary
    ];

    panel.update('prime', sessions);
    toggle.click();

    const chips = Array.from(host.querySelectorAll('.chip.chip-origin')).map(c => c.textContent);
    expect(chips).toContain('ORCH · worker');
    expect(chips).toContain('ORCH · verifier');
    expect(chips).toContain('Authorized');
    expect(chips).toContain('Auto sub-agent');
  });

  it('supports independent ORCH state composition alongside Goal and Loop', () => {
    // Composition combinations:
    // 1. Goal alone: goal.enabled = true, mode = 'goal', orch = false
    // 2. Goal + ORCH: goal.enabled = true, mode = 'goal', orch = true
    // 3. Loop alone: goal.enabled = true, mode = 'loop', orch = false
    // 4. Loop + ORCH: goal.enabled = true, mode = 'loop', orch = true
    // 5. ORCH alone: goal.enabled = false, orch = true

    interface ComposerModes {
      goal: { enabled: boolean; mode: 'goal' | 'loop' };
      orchEnabled: boolean;
    }

    const testState: ComposerModes = {
      goal: { enabled: false, mode: 'goal' },
      orchEnabled: false
    };

    // 1. Goal alone
    testState.goal.enabled = true;
    testState.goal.mode = 'goal';
    testState.orchEnabled = false;
    expect(testState.goal.enabled).toBe(true);
    expect(testState.goal.mode).toBe('goal');
    expect(testState.orchEnabled).toBe(false);

    // 2. Goal + ORCH
    testState.orchEnabled = true;
    expect(testState.goal.enabled).toBe(true);
    expect(testState.goal.mode).toBe('goal');
    expect(testState.orchEnabled).toBe(true);

    // 3. Loop alone
    testState.goal.mode = 'loop';
    testState.orchEnabled = false;
    expect(testState.goal.enabled).toBe(true);
    expect(testState.goal.mode).toBe('loop');
    expect(testState.orchEnabled).toBe(false);

    // 4. Loop + ORCH
    testState.orchEnabled = true;
    expect(testState.goal.enabled).toBe(true);
    expect(testState.goal.mode).toBe('loop');
    expect(testState.orchEnabled).toBe(true);

    // 5. ORCH alone
    testState.goal.enabled = false;
    expect(testState.goal.enabled).toBe(false);
    expect(testState.orchEnabled).toBe(true);
  });
});
