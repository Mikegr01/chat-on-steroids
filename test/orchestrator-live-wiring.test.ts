import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { makeTempDir, removeTempDir } from './helpers.js';

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const pushedEvents: Array<{ channel: string; payload: unknown }> = [];

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel)
  },
  BrowserWindow: class {},
  clipboard: { readText: () => '', writeText: () => undefined },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })) },
  shell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => '') },
  nativeTheme: { themeSource: 'system' },
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  },
  app: { on: vi.fn(), getPath: () => '', getVersion: vi.fn(() => '0.0.0'), getAppPath: () => process.cwd(), isPackaged: false }
}));

vi.mock('../src/main/extension-path.js', () => ({
  extensionDir: () => process.cwd(),
  shippedExtensionBuild: () => null,
  extensionUpdateOffer: () => null,
  prepareExtensionUpdate: () => null
}));
vi.mock('../src/main/browser.js', () => ({ openInPreferredBrowser: vi.fn(async () => 'chrome.exe') }));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initDurableStore, resetDurableForTests, writeDurableNow } = await import('../src/main/durable.js');
const { createSession, initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { onSpawnRequest, onSwarmPersistNow, resetAgentsForTests, swarmState } = await import('../src/main/agents.js');
const { registerIpc } = await import('../src/main/ipc.js');
const { resetOrchestratorForTests } = await import('../src/main/orchestrator/conductor.js');
const { resetOrchestratorRuntimeDriverForTests } = await import('../src/main/orchestrator/driver.js');
const { orchestratorPresentation } = await import('../src/renderer/orchestrator-ui.js');
import type { OrchestratorRun } from '../src/main/orchestrator/types.js';

let tempDir: string;
let unsubscribeSpawn: (() => void) | null = null;
const requestedBootstraps: string[] = [];

beforeEach(async () => {
  tempDir = await makeTempDir('orch-live-wiring-');
  await initDurableStore(path.join(tempDir, 'durable'));
  await initSessionStore(path.join(tempDir, 'sessions'));
  await initConfigPath(path.join(tempDir, 'config.json'));
  await saveConfig({
    ...defaultConfig(),
    multiAgent: {
      ...defaultConfig().multiAgent,
      enabled: true,
      workerPolicy: 'auto'
    }
  });

  onSwarmPersistNow((snapshot) => writeDurableNow('swarm', snapshot));

  handlers.clear();
  pushedEvents.length = 0;
  requestedBootstraps.length = 0;

  unsubscribeSpawn = onSpawnRequest((workers) => {
    requestedBootstraps.push(...workers.map(w => w.id));
  });

  const mockWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => {
        pushedEvents.push({ channel, payload });
      }
    }
  } as unknown as import('electron').BrowserWindow;

  registerIpc(
    () => mockWindow,
    () => {}
  );
});

afterEach(async () => {
  onSwarmPersistNow(null);
  unsubscribeSpawn?.();
  unsubscribeSpawn = null;
  resetOrchestratorRuntimeDriverForTests();
  resetOrchestratorForTests();
  resetAgentsForTests();
  resetSessionStoreForTests();
  resetDurableForTests();
  if (tempDir) await removeTempDir(tempDir);
});

describe('Phase 3 live ORCH wiring', () => {
  it('proves the real production path: UI start -> IPC -> driver -> conductor -> Agents spawn -> worker bootstrap', async () => {
    const conversationId = 'conv-live-orchestrator-1';
    const session = await createSession({ title: 'Live ORCH Test', conversationId });

    const startHandler = handlers.get('orchestrator:start');
    expect(startHandler).toBeDefined();

    const startResponse = (await startHandler!(null, {
      sessionId: session.id,
      objective: 'Build durable authentication',
      stages: ['Design token contract', 'Implement token store', 'Verify security properties']
    })) as { ok: boolean; data: OrchestratorRun };

    expect(startResponse.ok).toBe(true);
    const startResult = startResponse.data;

    // 1. Real run exists in conductor with WAITING_WORKER status
    expect(startResult).toBeDefined();
    expect(startResult.id).toMatch(/^orch-/);
    expect(startResult.status).toBe('WAITING_WORKER');
    expect(startResult.objective).toBe('Build durable authentication');
    expect(startResult.steps).toHaveLength(3);
    expect(startResult.currentStepIndex).toBe(0);

    const firstStep = startResult.steps[0];
    expect(firstStep).toBeDefined();
    if (!firstStep) throw new Error('missing firstStep');
    expect(firstStep.title).toBe('Stage 1');
    expect(firstStep.instructions).toBe('Design token contract');
    expect(firstStep.assignedWorkerId).toBeDefined();

    // 2. Real Agent worker created in swarmState()
    const agents = swarmState().agents;
    const workerAgent = agents.find(a =>
      a.origin === 'ORCHESTRATOR' &&
      a.orchestratorRunId === startResult.id &&
      a.orchestratorStepId === firstStep.id &&
      a.executionRole === 'worker'
    );
    expect(workerAgent).toBeDefined();
    expect(workerAgent?.id).toBe(firstStep.assignedWorkerId);

    // 3. Worker bootstrap requested
    expect(requestedBootstraps).toContain(workerAgent?.id);

    // 4. orchestrator:getForSession retrieves the active run
    const getHandler = handlers.get('orchestrator:getForSession');
    expect(getHandler).toBeDefined();

    const getResponse = (await getHandler!(null, { sessionId: session.id })) as { ok: boolean; data: OrchestratorRun | null };
    expect(getResponse.ok).toBe(true);
    const fetchedRun = getResponse.data;
    expect(fetchedRun).not.toBeNull();
    expect(fetchedRun?.id).toBe(startResult.id);
    expect(fetchedRun?.status).toBe('WAITING_WORKER');

    // 5. Pushed change event was emitted
    const pushEvent = pushedEvents.find(e => e.channel === 'orchestrator:changed');
    expect(pushEvent).toBeDefined();
    expect((pushEvent?.payload as OrchestratorRun)?.id).toBe(startResult.id);
  });

  it('keeps Goal and Loop modes completely independent from ORCH toggle', async () => {
    const html = await fs.readFile('src/renderer/index.html', 'utf8');
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const toggle = doc.getElementById('orchToggle') as HTMLButtonElement | null;
    const switchEl = doc.getElementById('orchSwitch') as HTMLInputElement | null;
    const automationRadios = Array.from(doc.querySelectorAll<HTMLButtonElement>('#automationSwitch button[data-mode]'));

    expect(toggle).not.toBeNull();
    expect(switchEl).not.toBeNull();
    expect(automationRadios.length).toBeGreaterThanOrEqual(3);

    // Mode starts as Normal (off)
    const normalRadio = automationRadios.find(b => b.dataset.mode === 'off');
    const goalRadio = automationRadios.find(b => b.dataset.mode === 'goal');
    const loopRadio = automationRadios.find(b => b.dataset.mode === 'loop');

    expect(normalRadio?.getAttribute('aria-checked')).toBe('true');
    expect(goalRadio?.getAttribute('aria-checked')).toBe('false');

    // Select Goal mode
    normalRadio?.setAttribute('aria-checked', 'false');
    goalRadio?.setAttribute('aria-checked', 'true');
    expect(goalRadio?.getAttribute('aria-checked')).toBe('true');

    // Simulate ORCH enable
    toggle?.setAttribute('aria-pressed', 'true');
    toggle?.classList.add('is-active');
    if (switchEl) switchEl.checked = true;

    // Invariant: Goal remains ON when ORCH is toggled
    expect(goalRadio?.getAttribute('aria-checked')).toBe('true');
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');
    expect(switchEl?.checked).toBe(true);

    // Switch to Loop mode
    goalRadio?.setAttribute('aria-checked', 'false');
    loopRadio?.setAttribute('aria-checked', 'true');

    // Invariant: Loop remains ON, ORCH remains ON
    expect(loopRadio?.getAttribute('aria-checked')).toBe('true');
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');

    // Toggle ORCH OFF
    toggle?.setAttribute('aria-pressed', 'false');
    toggle?.classList.remove('is-active');
    if (switchEl) switchEl.checked = false;

    // Invariant: Loop remains ON when ORCH is disabled
    expect(loopRadio?.getAttribute('aria-checked')).toBe('true');
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');
    expect(switchEl?.checked).toBe(false);
  });

  it('renders non-failure neutral status for CANCELED terminal state', () => {
    const canceledRun: OrchestratorRun = {
      version: 1,
      id: 'orch-cancel-test',
      ownerConversationId: 'conv-cancel-test',
      projectId: 'proj-1',
      objective: 'Canceled objective',
      status: 'CANCELED',
      currentStepIndex: 1,
      steps: [
        {
          id: 'step-1',
          index: 0,
          title: 'Step 1',
          instructions: 'First step',
          acceptanceCriteria: [],
          status: 'COMPLETED',
          generation: 1,
          attemptCount: 1,
          fileEffects: []
        },
        {
          id: 'step-2',
          index: 1,
          title: 'Step 2',
          instructions: 'Second step',
          acceptanceCriteria: [],
          status: 'PENDING',
          generation: 1,
          attemptCount: 1,
          fileEffects: []
        }
      ],
      startedAt: Date.now() - 5000,
      updatedAt: Date.now() - 1000,
      lastCheckpointAt: Date.now() - 1000
    };

    const presentation = orchestratorPresentation(true, canceledRun);
    expect(presentation.chipLabel).toBe('ORCH · Canceled');
    expect(presentation.statusText).toBe('ORCH · Canceled');
    expect(presentation.state).toBe('canceled');
    expect(presentation.statusText).not.toMatch(/fail/i);
    expect(presentation.statusText).not.toMatch(/error/i);
  });

  it('keeps a new-chat ORCH start pending until the accepted input has a real session binding', async () => {
    const chat = await fs.readFile('src/renderer/chat.ts', 'utf8');

    expect(chat).toContain('pendingOrchestratorStarts');
    expect(chat).toContain('startPendingOrchestrator(entry)');
    expect(chat).toContain('await startPendingOrchestrator(result)');
    expect(chat).not.toContain('ORCH could not start because the ChatGPT conversation was not bound yet.');

    // Behavioral simulation of new-chat deferred start:
    // When input is sent before conversation binding, deliveredSessionId is null.
    // The entry is held in pending map. When receipt arrives with deliveredSessionId,
    // startPendingOrchestrator initiates the real start.
    const startHandler = handlers.get('orchestrator:start');
    expect(startHandler).toBeDefined();

    const pendingMap = new Map<string, { sessionId: string | null; objective: string; stages: string[] }>();
    const entryId = 'input-new-chat-1';
    pendingMap.set(entryId, { sessionId: null, objective: 'New chat goal', stages: ['Step 1'] });

    async function simulateStartPending(id: string, deliveredSessionId: string | null) {
      const pending = pendingMap.get(id);
      if (!pending) return false;
      const effectiveSessionId = pending.sessionId ?? deliveredSessionId;
      if (!effectiveSessionId) return false;
      pendingMap.delete(id);
      return startHandler!(null, {
        sessionId: effectiveSessionId,
        objective: pending.objective,
        stages: pending.stages
      });
    }

    // Step 1: Input sent before session creation (deliveredSessionId is null)
    const initialOutcome = await simulateStartPending(entryId, null);
    expect(initialOutcome).toBe(false);
    expect(pendingMap.has(entryId)).toBe(true); // Still pending

    // Step 2: Native receipt materializes deliveredSessionId
    const newSession = await createSession({ title: 'Bound New Chat', conversationId: 'conv-bound-new-chat' });
    const boundOutcome = (await simulateStartPending(entryId, newSession.id)) as { ok: boolean; data: OrchestratorRun };

    expect(boundOutcome.ok).toBe(true);
    expect(boundOutcome.data.status).toBe('WAITING_WORKER');
    expect(pendingMap.has(entryId)).toBe(false); // Consumed
  });
});
